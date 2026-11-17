// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from 'forge-std/Test.sol';
import {DeployLockboxes} from '../../script/DeployLockboxes.s.sol';
import {TestToken} from './TestToken.sol';
import {XERC20} from '../../contracts/XERC20.sol';

contract DeployLockboxesTest is Test {
  string internal constant MANIFEST = '.deployment/test/deployment.json';

  DeployLockboxes internal script;
  DeployLockboxes.Config internal cfg;

  function setUp() public {
    script = new DeployLockboxes();
    cfg.chainId = block.chainid;
    cfg.governor = address(0xbeef);
    cfg.name = 'Dev claim';
    cfg.symbol = 'X';
    cfg.assetDecimals = 6;
    cfg.majorIndex = 1;
    cfg.tokens.push(address(new TestToken(6)));
    cfg.tokens.push(address(new TestToken(6)));
    cfg.mintLimits = [type(uint256).max / 2, 0];
    cfg.burnLimits = [type(uint256).max / 2, 0];
  }

  function testValidConfiguration() public view {
    script.validate(cfg);
  }

  function testRejectWrongChain() public {
    cfg.chainId++;
    vm.expectRevert(bytes('Wrong chain'));
    script.validate(cfg);
  }

  function testRejectDuplicateAsset() public {
    cfg.tokens[1] = cfg.tokens[0];
    vm.expectRevert(bytes('Duplicate token'));
    script.validate(cfg);
  }

  function testRejectBadDecimals() public {
    cfg.tokens[0] = address(new TestToken(18));
    vm.expectRevert(bytes('Asset decimals mismatch'));
    script.validate(cfg);
  }

  function testRejectMissingGovernor() public {
    cfg.governor = address(0);
    vm.expectRevert(bytes('Missing governor'));
    script.validate(cfg);
  }

  function testDeployAndVerifyFromJson() public {
    DeployLockboxes.Deployment memory d = _run(address(0), false);
    assertEq(XERC20(d.xerc20).owner(), cfg.governor);
    assertEq(XERC20(d.xerc20).lockbox(), d.lockboxes[1]);
    assertEq(XERC20(d.xerc20).totalSupply(), 0);
    assertEq(XERC20(d.xerc20).mintingMaxLimitOf(d.lockboxes[0]), type(uint256).max / 2);
    assertEq(XERC20(d.xerc20).burningMaxLimitOf(d.lockboxes[0]), type(uint256).max / 2);
    assertEq(XERC20(d.xerc20).mintingCurrentLimitOf(d.lockboxes[0]), type(uint256).max / 2);
    assertEq(XERC20(d.xerc20).burningCurrentLimitOf(d.lockboxes[0]), type(uint256).max / 2);
    script.check();
    // Verification must detect governance/limit drift rather than trust the file.
    vm.prank(cfg.governor);
    XERC20(d.xerc20).setLimits(d.lockboxes[0], 1, 1);
    vm.expectRevert(bytes('Wrong mint limit'));
    script.check();
    // A configured factory is reused and configured limits are applied.
    cfg.symbol = 'Y';
    cfg.mintLimits[0] = 7;
    cfg.burnLimits[0] = 9;
    DeployLockboxes.Deployment memory reused = _run(d.factory, true);
    assertEq(reused.factory, d.factory);
    assertEq(XERC20(reused.xerc20).FACTORY(), d.factory);
    assertEq(XERC20(reused.xerc20).mintingMaxLimitOf(reused.lockboxes[0]), 7);
    assertEq(XERC20(reused.xerc20).burningMaxLimitOf(reused.lockboxes[0]), 9);
  }

  function _run(
    address factory,
    bool limits
  ) internal returns (DeployLockboxes.Deployment memory) {
    vm.createDir('.deployment/test', true);
    string memory path = '.deployment/test/config.json';
    string memory key = cfg.symbol;
    if (factory != address(0)) vm.serializeAddress(key, 'factory', factory);
    vm.serializeUint(key, 'chainId', cfg.chainId);
    vm.serializeAddress(key, 'governor', cfg.governor);
    vm.serializeString(key, 'name', cfg.name);
    vm.serializeString(key, 'symbol', cfg.symbol);
    vm.serializeUint(key, 'assetDecimals', uint256(cfg.assetDecimals));
    vm.serializeUint(key, 'majorIndex', cfg.majorIndex);
    if (limits) {
      vm.serializeUint(key, 'mintLimits', cfg.mintLimits);
      vm.serializeUint(key, 'burnLimits', cfg.burnLimits);
    }
    vm.writeJson(vm.serializeAddress(key, 'tokens', cfg.tokens), path);
    vm.setEnv('DEPLOYMENT_CONFIG', path);
    vm.setEnv('DEPLOYMENT_MANIFEST', MANIFEST);
    vm.setEnv('DEPLOYER_ADDRESS', vm.toString(address(0x1234)));
    return script.run();
  }
}
