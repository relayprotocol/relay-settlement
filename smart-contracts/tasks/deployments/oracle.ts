import { task } from 'hardhat/config'
import OracleModule from '../../ignition/modules/Oracle'

task('deploy:oracle', 'Deploy the Oracle contract')
  .addOptionalParam('hub', 'The address of the Hub contract')
  .addOptionalParam('admin', 'The address of the Hub admin')
  .setAction(async ({ admin, hub }, { viem, ignition }) => {
    const [deployer] = await viem.getWalletClients()
    if (!admin) {
      admin = deployer.account.address
    }
    const { oracle } = await ignition.deploy(OracleModule, {
      parameters: {
        Oracle: {
          admin,
          hub,
        },
      },
    })

    console.log(`Oracle deployed to: ${oracle.address}`)
  })
