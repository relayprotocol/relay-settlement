import { task } from 'hardhat/config'
import AllocatorModule from '../../ignition/modules/Allocator'

task('deploy:allocator', 'Deploy the Hub contract')
  .addParam('admin', 'The address of the admin multisig')
  .addOptionalParam('delay', 'The delay in seconds', 120n)
  .setAction(async ({ admin }, { ignition }) => {
    const { allocator } = await ignition.deploy(AllocatorModule, {
      parameters: {
        Allocator: {
          admin,
        },
      },
    })

    console.log(`Allocator deployed to: ${allocator.address}`)
  })
