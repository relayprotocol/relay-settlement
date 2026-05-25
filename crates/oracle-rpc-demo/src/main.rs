//! Minimal `eth_call` JSON-RPC server for demoing the price oracle precompile.
//!
//! Boots once, listens on 127.0.0.1:8545, dispatches every `eth_call` through
//! a real revm EVM that has our precompile registered at
//! `oracle_reth::PRICE_ORACLE_ADDRESS`. All other JSON-RPC methods return
//! `-32601 Method not found` — this is a demo, not a node.
//!
//! Run with:
//!
//! ```sh
//! cargo run -p oracle-rpc-demo
//! ```
//!
//! Then from another shell:
//!
//! ```sh
//! curl -s -X POST -H 'Content-Type: application/json' \
//!   --data '{
//!     "jsonrpc":"2.0","id":1,"method":"eth_call",
//!     "params":[{"to":"0x000000000000000000000000000000000000FEED",
//!                "data":"0x2695b3a20000000000000000000000000000000000000000000000000000000000000001"},"latest"]
//!   }' http://127.0.0.1:8545
//! ```

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

use alloy_primitives::{address, hex, Address, Bytes, TxKind, U256};
use oracle_reth::PRICE_ORACLE_ADDRESS;
use price_oracle_precompile::{run, PrecompileError as CoreError};
use revm::{
    context::TxEnv,
    context_interface::result::{ExecutionResult, Output},
    database::{CacheDB, EmptyDB},
    handler::EthPrecompiles,
    precompile::{
        Precompile, PrecompileHalt, PrecompileId, PrecompileOutput, PrecompileResult, Precompiles,
    },
    primitives::hardfork::SpecId,
    state::AccountInfo,
    Context, ExecuteEvm, MainBuilder, MainContext,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

const LISTEN_ADDR: &str = "127.0.0.1:8547";
const CALLER: Address = address!("0x0000000000000000000000000000000000C0FFEE");
const SPEC: SpecId = SpecId::CANCUN;

fn price_oracle_precompile_fn(input: &[u8], gas_limit: u64, reservoir: u64) -> PrecompileResult {
    match run(input, gas_limit) {
        Ok(o) => Ok(PrecompileOutput::new(
            o.gas_used,
            o.output.into(),
            reservoir,
        )),
        Err(CoreError::OutOfGas) => Ok(PrecompileOutput::halt(PrecompileHalt::OutOfGas, reservoir)),
        Err(_) => Ok(PrecompileOutput::revert(0, Bytes::new(), reservoir)),
    }
}

fn precompiles_with_oracle() -> &'static Precompiles {
    static SET: OnceLock<Precompiles> = OnceLock::new();
    SET.get_or_init(|| {
        let mut p = Precompiles::latest().clone();
        p.extend([Precompile::new(
            PrecompileId::custom("price-oracle"),
            PRICE_ORACLE_ADDRESS,
            price_oracle_precompile_fn,
        )]);
        p
    })
}

#[derive(Deserialize)]
struct CallParams {
    to: Address,
    #[serde(default)]
    data: Option<String>,
    #[serde(default, rename = "input")]
    input: Option<String>,
}

/// Pure execution helper: build an EVM with the oracle precompile, dispatch
/// a single CALL, return (gas_used, return_bytes). Shared by the JSON-RPC
/// handler and the `--once` smoke-test path.
fn execute_call(to: Address, calldata: Vec<u8>) -> Result<(u64, Bytes), String> {
    let mut db = CacheDB::new(EmptyDB::default());
    db.insert_account_info(
        CALLER,
        AccountInfo {
            balance: U256::from(10u64).pow(U256::from(18u64)),
            ..Default::default()
        },
    );

    let mut evm = Context::mainnet()
        .with_db(db)
        .modify_cfg_chained(|cfg| {
            cfg.spec = SPEC;
            cfg.disable_nonce_check = true;
        })
        .modify_block_chained(|b| {
            b.basefee = 0;
        })
        .build_mainnet()
        .with_precompiles(EthPrecompiles {
            precompiles: precompiles_with_oracle(),
            spec: SPEC,
        });

    let tx = TxEnv {
        caller: CALLER,
        kind: TxKind::Call(to),
        data: calldata.into(),
        gas_limit: 200_000,
        gas_price: 0,
        value: U256::ZERO,
        ..Default::default()
    };

    let res = evm
        .transact(tx)
        .map_err(|e| format!("execution error: {e:?}"))?;

    match res.result {
        ExecutionResult::Success { output, gas, .. } => {
            let bytes: Bytes = match output {
                Output::Call(b) => b,
                Output::Create(b, _) => b,
            };
            Ok((gas.tx_gas_used(), bytes))
        }
        ExecutionResult::Revert { output, .. } => {
            Err(format!("execution reverted: 0x{}", hex::encode(&output)))
        }
        ExecutionResult::Halt { reason, .. } => Err(format!("halt: {reason:?}")),
    }
}

fn run_eth_call(params: &Value) -> Result<String, (i64, String)> {
    let call: CallParams = serde_json::from_value(
        params
            .get(0)
            .ok_or((-32602, "missing call object".into()))?
            .clone(),
    )
    .map_err(|e| (-32602, format!("bad call object: {e}")))?;

    let data_hex = call
        .data
        .or(call.input)
        .ok_or((-32602, "call missing data/input".into()))?;
    let calldata = hex::decode(data_hex.strip_prefix("0x").unwrap_or(&data_hex))
        .map_err(|e| (-32602, format!("bad hex: {e}")))?;

    let (_, bytes) = execute_call(call.to, calldata).map_err(|m| (-32000, m))?;
    Ok(format!("0x{}", hex::encode(&bytes)))
}

fn handle_rpc(body: &str) -> String {
    let req: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return error_response(Value::Null, -32700, format!("parse error: {e}")),
    };

    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_else(|| json!([]));

    eprintln!("→ {method} {params}");

    match method {
        "eth_call" => match run_eth_call(&params) {
            Ok(result) => success_response(id, json!(result)),
            Err((code, msg)) => error_response(id, code, msg),
        },
        _ => error_response(id, -32601, format!("method '{method}' not supported")),
    }
}

fn success_response(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_response(id: Value, code: i64, message: String) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

/// Bare-minimum HTTP/1.1 handler: read until headers end, parse
/// Content-Length, read the body, hand it to `handle_rpc`, write a single
/// response. Closes the connection after one request.
fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 1024];
    let headers_end = loop {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 1 << 20 {
            return Ok(());
        }
    };

    let headers = std::str::from_utf8(&buf[..headers_end]).unwrap_or("");
    let content_length = headers
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim().eq_ignore_ascii_case("content-length")).then(|| v.trim().parse().ok())?
        })
        .unwrap_or(0usize);

    while buf.len() < headers_end + content_length {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = std::str::from_utf8(&buf[headers_end..headers_end + content_length]).unwrap_or("");

    let response_body = handle_rpc(body);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response_body.len(),
        response_body,
    );
    stream.write_all(response.as_bytes())?;
    Ok(())
}

/// One-shot smoke test: dispatch `getUsdPrice(ETH)` through the same EVM,
/// print the full trace, exit. Lets you sanity-check the precompile without
/// binding a port.
fn once_mode() {
    use alloy_sol_types::{SolCall, SolValue};
    use price_oracle_precompile::{IPriceOraclePrecompile::getUsdPriceCall, TOKEN_ID_ETH};

    let calldata = getUsdPriceCall {
        tokenId: U256::from(TOKEN_ID_ETH),
    }
    .abi_encode();

    println!("→ from:      {CALLER}");
    println!("→ to:        {PRICE_ORACLE_ADDRESS}");
    println!("→ calldata:  0x{}", hex::encode(&calldata));

    match execute_call(PRICE_ORACLE_ADDRESS, calldata) {
        Ok((gas_used, bytes)) => {
            let price = U256::abi_decode(&bytes).expect("decode uint256");
            let whole = price / U256::from(100_000_000u64);
            let cents = (price % U256::from(100_000_000u64)) / U256::from(1_000_000u64);
            println!("← gas used:  {gas_used}");
            println!("← raw:       0x{}", hex::encode(&bytes));
            println!("← decoded:   {price}  (USD scaled by 1e8)");
            println!("← human:     ${whole}.{cents:02}");
        }
        Err(e) => {
            eprintln!("! {e}");
            std::process::exit(1);
        }
    }
}

fn main() {
    if std::env::args().any(|a| a == "--once") {
        once_mode();
        return;
    }

    let listener = TcpListener::bind(LISTEN_ADDR).expect("bind");
    eprintln!("oracle-rpc-demo listening on http://{LISTEN_ADDR}");
    eprintln!("precompile mounted at {PRICE_ORACLE_ADDRESS}");
    eprintln!("(run with --once for a single local call without binding a port)");
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                if let Err(e) = serve(s) {
                    eprintln!("! serve error: {e}");
                }
            }
            Err(e) => eprintln!("! accept error: {e}"),
        }
    }
}
