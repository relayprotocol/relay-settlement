// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Script} from 'forge-std/Script.sol';
import {console2} from 'forge-std/console2.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {XERC20} from '../contracts/XERC20.sol';
import {XERC20Factory} from '../contracts/XERC20Factory.sol';
import {XERC20Lockbox} from '../contracts/XERC20Lockbox.sol';

// The pinned forge-std predates `keyExistsJson`, which replaces the deprecated `keyExists`.
interface IVmJson {
  function keyExistsJson(
    string calldata json,
    string calldata key
  ) external view returns (bool);
}

contract DeployLockboxes is Script {
  // Upstream has no unlimited flag for ordinary bridge callers. Its largest
  // supported capacity removes practical rate caps without changing contracts.
  uint256 public constant INITIAL_CAPACITY = type(uint256).max / 2;

  struct Config {
    uint256 chainId;
    address factory;
    address governor;
    string name;
    string symbol;
    uint8 assetDecimals;
    uint256 majorIndex;
    address[] tokens;
    uint256[] mintLimits;
    uint256[] burnLimits;
    bytes32 configHash;
  }

  struct Deployment {
    address factory;
    address xerc20;
    address[] lockboxes;
  }

  struct RecordedLockbox {
    string label;
    address lockbox;
    bool privileged;
    address token;
  }

  function config() public view returns (Config memory c) {
    c = config(vm.envString('DEPLOYMENT_CONFIG'));
  }

  function config(
    string memory path
  ) public view returns (Config memory c) {
    string memory json = vm.readFile(path);
    c.chainId = vm.parseJsonUint(json, '.chainId');
    if (IVmJson(address(vm)).keyExistsJson(json, '.factory')) c.factory = vm.parseJsonAddress(json, '.factory');
    c.governor = vm.parseJsonAddress(json, '.governor');
    c.name = vm.parseJsonString(json, '.name');
    c.symbol = vm.parseJsonString(json, '.symbol');
    uint256 decimals = vm.parseJsonUint(json, '.assetDecimals');
    require(decimals <= 18, 'Invalid decimals');
    c.assetDecimals = uint8(decimals);
    c.majorIndex = vm.parseJsonUint(json, '.majorIndex');
    c.tokens = vm.parseJsonAddressArray(json, '.tokens');
    c.mintLimits = _limits(json, '.mintLimits', c);
    c.burnLimits = _limits(json, '.burnLimits', c);
    c.configHash = keccak256(bytes(json));
  }

  function _limits(
    string memory json,
    string memory key,
    Config memory c
  ) internal view returns (uint256[] memory limits) {
    if (IVmJson(address(vm)).keyExistsJson(json, key)) return vm.parseJsonUintArray(json, key);
    limits = new uint256[](c.tokens.length);
    for (uint256 i; i < limits.length; ++i) {
      if (i != c.majorIndex) limits[i] = INITIAL_CAPACITY;
    }
  }

  function validate(
    Config memory c
  ) public view {
    require(block.chainid == c.chainId, 'Wrong chain');
    require(c.factory == address(0) || c.factory.code.length != 0, 'Factory has no code');
    require(c.governor != address(0), 'Missing governor');
    require(bytes(c.name).length > 0 && bytes(c.symbol).length > 0, 'Missing token name');
    require(c.tokens.length >= 2 && c.majorIndex < c.tokens.length, 'Invalid assets');
    require(c.mintLimits.length == c.tokens.length && c.burnLimits.length == c.tokens.length, 'Invalid limits');
    for (uint256 i; i < c.tokens.length; ++i) {
      require(c.tokens[i].code.length != 0, 'Token has no code');
      require(IERC20Metadata(c.tokens[i]).decimals() == c.assetDecimals, 'Asset decimals mismatch');
      if (i == c.majorIndex) {
        require(c.mintLimits[i] == 0 && c.burnLimits[i] == 0, 'Major lockbox has limits');
      } else {
        require(c.mintLimits[i] <= INITIAL_CAPACITY && c.burnLimits[i] <= INITIAL_CAPACITY, 'Limits too high');
      }
      for (uint256 j; j < i; ++j) {
        require(c.tokens[i] != c.tokens[j], 'Duplicate token');
      }
    }
  }

  /// @notice Read-only RPC preflight. No key, broadcast, deployment, or manifest.
  function plan() external view {
    Config memory c = config();
    validate(c);
    console2.log('Chain', c.chainId);
    if (c.factory == address(0)) {
      console2.log('Factory: new deployment');
    } else {
      console2.log('Factory', c.factory);
    }
    console2.log('Governor', c.governor);
    console2.log('Assets', c.tokens.length);
    console2.log('Major asset', c.tokens[c.majorIndex]);
    console2.log('Underlying decimals', uint256(c.assetDecimals));
    console2.log('Unmodified XERC20 decimals: 18; amounts stay in underlying RAW units.');
    for (uint256 i; i < c.tokens.length; ++i) {
      console2.log('Token', c.tokens[i]);
      if (i == c.majorIndex) {
        console2.log('Privileged lockbox: mint/burn limits bypassed.');
      } else {
        console2.log('Daily mint/burn limit (raw)', c.mintLimits[i], c.burnLimits[i]);
      }
    }
  }

  function run() external returns (Deployment memory d) {
    Config memory c = config();
    validate(c);
    address deployer = vm.envAddress('DEPLOYER_ADDRESS');
    require(deployer != address(0), 'Missing deployer');
    vm.startBroadcast(deployer);
    d.factory = c.factory == address(0) ? address(new XERC20Factory()) : c.factory;
    d.xerc20 =
      XERC20Factory(d.factory).deployXERC20(c.name, c.symbol, new uint256[](0), new uint256[](0), new address[](0));
    XERC20 x = XERC20(d.xerc20);
    d.lockboxes = new address[](c.tokens.length);
    d.lockboxes[c.majorIndex] = XERC20Factory(d.factory).deployLockbox(d.xerc20, c.tokens[c.majorIndex], false);
    for (uint256 i; i < c.tokens.length; ++i) {
      if (i == c.majorIndex) continue;
      // The factory supports just ONE privileged lockbox. Additional unmodified
      // lockboxes are ordinary bridge callers initialized with the configured limits.
      d.lockboxes[i] = address(new XERC20Lockbox(d.xerc20, c.tokens[i], false));
      x.setLimits(d.lockboxes[i], c.mintLimits[i], c.burnLimits[i]);
    }
    x.transferOwnership(c.governor);
    vm.stopBroadcast();
    _verify(c, d);
    _writeManifest(c, d, deployer);
  }

  function check() external view {
    string memory json = vm.readFile(vm.envString('DEPLOYMENT_MANIFEST'));
    _check(
      config(),
      vm.parseJsonBytes32(json, '.configHash'),
      vm.parseJsonUint(json, '.chainId'),
      Deployment({
        factory: vm.parseJsonAddress(json, '.factory'),
        xerc20: vm.parseJsonAddress(json, '.xerc20'),
        lockboxes: vm.parseJsonAddressArray(json, '.lockboxes')
      })
    );
  }

  function check(
    string memory env,
    string memory token
  ) external view {
    string memory json = vm.readFile(string.concat('deployments/contracts/', env, '.json'));
    string memory key = string.concat('.tokens.', token);
    Config memory c =
      config(string.concat('deployments/configs/', vm.parseJsonString(json, string.concat(key, '.name')), '.json'));
    RecordedLockbox[] memory boxes =
      abi.decode(vm.parseJson(json, string.concat(key, '.lockboxes')), (RecordedLockbox[]));
    require(boxes.length == c.tokens.length, 'Wrong lockbox count');
    Deployment memory d = Deployment({
      factory: vm.parseJsonAddress(json, '.factory'),
      xerc20: vm.parseJsonAddress(json, string.concat(key, '.address')),
      lockboxes: new address[](boxes.length)
    });
    for (uint256 i; i < boxes.length; ++i) {
      require(
        boxes[i].token == c.tokens[i] && boxes[i].privileged == (i == c.majorIndex), 'Record does not match config'
      );
      d.lockboxes[i] = boxes[i].lockbox;
    }
    _check(
      c, vm.parseJsonBytes32(json, string.concat(key, '.deployment.configHash')), vm.parseJsonUint(json, '.chainId'), d
    );
  }

  function _check(
    Config memory c,
    bytes32 configHash,
    uint256 chainId,
    Deployment memory d
  ) internal view {
    validate(c);
    require(configHash == c.configHash, 'Config changed since deployment');
    require(chainId == block.chainid, 'Manifest chain mismatch');
    _verify(c, d);
    console2.log('Verified live ownership, lockboxes, decimals, and limits.');
  }

  function _verify(
    Config memory c,
    Deployment memory d
  ) internal view {
    require(d.factory.code.length != 0, 'Missing deployed code');
    require(c.factory == address(0) || c.factory == d.factory, 'Wrong factory');
    XERC20 x = XERC20(d.xerc20);
    require(x.FACTORY() == d.factory && x.owner() == c.governor, 'Wrong X ownership');
    require(x.decimals() == 18, 'Unexpected X decimals');
    require(d.lockboxes.length == c.tokens.length, 'Wrong lockbox count');
    require(x.lockbox() == d.lockboxes[c.majorIndex], 'Wrong major lockbox');
    for (uint256 i; i < c.tokens.length; ++i) {
      XERC20Lockbox box = XERC20Lockbox(payable(d.lockboxes[i]));
      require(
        address(box.XERC20()) == d.xerc20 && address(box.ERC20()) == c.tokens[i] && !box.IS_NATIVE(), 'Wrong lockbox'
      );
      if (i != c.majorIndex) {
        require(x.mintingMaxLimitOf(d.lockboxes[i]) == c.mintLimits[i], 'Wrong mint limit');
        require(x.burningMaxLimitOf(d.lockboxes[i]) == c.burnLimits[i], 'Wrong burn limit');
      }
    }
  }

  function _writeManifest(
    Config memory c,
    Deployment memory d,
    address deployer
  ) internal {
    string memory key = 'deployment';
    vm.serializeUint(key, 'chainId', c.chainId);
    vm.serializeBytes32(key, 'configHash', c.configHash);
    vm.serializeAddress(key, 'deployer', deployer);
    vm.serializeAddress(key, 'governor', c.governor);
    vm.serializeAddress(key, 'factory', d.factory);
    vm.serializeAddress(key, 'xerc20', d.xerc20);
    vm.serializeAddress(key, 'tokens', c.tokens);
    vm.serializeAddress(key, 'lockboxes', d.lockboxes);
    vm.serializeUint(key, 'majorIndex', c.majorIndex);
    vm.serializeUint(key, 'assetDecimals', uint256(c.assetDecimals));
    string memory json = vm.serializeUint(key, 'xerc20Decimals', uint256(18));
    // Forge runs this during SIMULATION, before broadcast.
    vm.writeJson(json, vm.envString('DEPLOYMENT_MANIFEST'));
    console2.log('Deployment plan saved; live verification is still required.');
  }
}
