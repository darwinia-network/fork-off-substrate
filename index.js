const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
require("dotenv").config();
const { ApiPromise } = require('@polkadot/api');
const { HttpProvider } = require('@polkadot/rpc-provider');
const { xxhashAsHex } = require('@polkadot/util-crypto');
const execFileSync = require('child_process').execFileSync;
const execSync = require('child_process').execSync;
const binaryPath = path.join(__dirname, 'data', 'binary');
const wasmPath = path.join(__dirname, 'data', 'runtime.wasm');
const schemaPath = path.join(__dirname, 'data', 'schema.json');
const hexPath = path.join(__dirname, 'data', 'runtime.hex');
const originalSpecPath = path.join(__dirname, 'data', 'genesis.json');
const forkedSpecPath = path.join(__dirname, 'data', 'fork.json');
const storagePath = path.join(__dirname, 'data', 'storage.json');

// Using http endpoint since substrate's Ws endpoint has a size limit.
const provider = new HttpProvider(process.env.HTTP_RPC_ENDPOINT || 'http://localhost:9933')
// The storage download will be split into 256^chunksLevel chunks.
const chunksLevel = process.env.FORK_CHUNKS_LEVEL || 1;
const totalChunks = Math.pow(256, chunksLevel);

const chain = process.env.CHAIN || ''
const alice = process.env.ALICE || ''

let chunksFetched = 0;
let separator = false;
const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

let total_keys_count = 0;
let api;

/**
 * All module prefixes except those mentioned in the skippedModulesPrefix will be added to this by the script.
 * If you want to add any past module or part of a skipped module, add the prefix here manually.
 *
 * Any storage value’s hex can be logged via console.log(api.query.<module>.<call>.key([...opt params])),
 * e.g. console.log(api.query.timestamp.now.key()).
 *
 * If you want a map/doublemap key prefix, you can do it via .keyPrefix(),
 * e.g. console.log(api.query.system.account.keyPrefix()).
 *
 * For module hashing, do it via xxhashAsHex,
 * e.g. console.log(xxhashAsHex('System', 128)).
 */
let prefixes = ['0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9' /* System.Account */];
const skippedModulesPrefix = ['Session', 'Babe', 'Grandpa', 'GrandpaFinality', 'FinalityTracker', 'Authorship'];

async function main() {
  if (!fs.existsSync(binaryPath)) {
    console.log(chalk.red('Binary missing. Please copy the binary of your substrate node to the data folder and rename the binary to "binary"'));
    process.exit(1);
  }
  execFileSync('chmod', ['+x', binaryPath]);

  if (!fs.existsSync(wasmPath)) {
    console.log(chalk.red('WASM missing. Please copy the WASM blob of your substrate node to the data folder and rename it to "runtime.wasm"'));
    process.exit(1);
  }
  execSync('cat ' + wasmPath + ' | hexdump -ve \'/1 "%02x"\' > ' + hexPath);

  console.log(chalk.green('We are intentionally using the HTTP endpoint. If you see any warnings about that, please ignore them.'));
  if (!fs.existsSync(schemaPath)) {
    console.log(chalk.yellow('Custom Schema missing, using default schema.'));
    api = await ApiPromise.create({ provider });
  } else {
    const { types, rpc } = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    api = await ApiPromise.create({
      provider,
      types,
      rpc,
    });
  }

  if (fs.existsSync(storagePath)) {
    console.log(chalk.yellow('Reusing cached storage. Delete ./data/storage.json and rerun the script if you want to fetch latest storage'));
  } else {
    // Download state of original chain
    console.log(chalk.green('Fetching current state of the live chain. Please wait, it can take a while depending on the size of your chain.'));
    progressBar.start(totalChunks, 0);
    const stream = fs.createWriteStream(storagePath, { flags: 'a' });
    stream.write("[");
    const at = await provider.send('chain_getFinalizedHead', []);

    console.log(chalk.green('Starting to fetch key pairs at block: ' + at ));
    await fetchChunks("0x", chunksLevel, stream, at);
    stream.write("]");
    stream.end();
    progressBar.stop();
  }

  const metadata = await api.rpc.state.getMetadata();
  // Populate the prefixes array
  const modules = metadata.asLatest.pallets;
  modules.forEach((module) => {
    if (module.storage) {
      if (!skippedModulesPrefix.includes(module.name.toString())) {
        prefixes.push(xxhashAsHex(module.name, 128));
      } else {
        console.log("skipped", module.name);
      }
    }
  });

  // Generate chain spec for original and forked chains
  if (chain === '') {
    execSync(binaryPath + ' build-spec --raw > ' + originalSpecPath);
    execSync(binaryPath + ' build-spec --dev --raw > ' + forkedSpecPath);
  } else {
    execSync(binaryPath + ' build-spec' + ' --chain ' + chain + ' --raw > ' + originalSpecPath);
    execSync(binaryPath + ' build-spec' + ' --chain ' + chain + '-dev' + ' --raw > ' + forkedSpecPath);
  }

  let storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  let originalSpec = JSON.parse(fs.readFileSync(originalSpecPath, 'utf8'));
  let forkedSpec = JSON.parse(fs.readFileSync(forkedSpecPath, 'utf8'));

  // Modify chain name and id
  forkedSpec.name = originalSpec.name + '-fork';
  forkedSpec.id = originalSpec.id + '-fork';
  forkedSpec.protocolId = originalSpec.protocolId;

  // Grab the items to be moved, then iterate through and insert into storage
  storage
    .filter((i) => prefixes.some((prefix) => i[0].startsWith(prefix)))
    .forEach(([key, value]) => (forkedSpec.genesis.raw.top[key] = value));

  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  delete forkedSpec.genesis.raw.top['0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8'];

  // Set the code to the current runtime code
  forkedSpec.genesis.raw.top['0x3a636f6465'] = '0x' + fs.readFileSync(hexPath, 'utf8').trim();

  // To prevent the validator set from changing mid-test, set Staking.ForceEra to ForceNone ('0x02')
  forkedSpec.genesis.raw.top['0x5f3e4907f716ac89b6347d15ececedcaf7dad0317324aecae8744b87fc95f2f3'] = '0x02';

  if (alice !== '') {
    // Set sudo key to //Alice
    forkedSpec.genesis.raw.top['0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b'] = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
    // TechnicalMembership
    forkedSpec.genesis.raw.top['0x3a2d6c9353500637d8f8e3e0fa0bb1c5ba7fb8745735dc3be2a2c61a72c39e78'] = '0x04d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
    // TechnicalCommittee
    forkedSpec.genesis.raw.top['0xed25f63942de25ac5253ba64b5eb64d1ba7fb8745735dc3be2a2c61a72c39e78'] = '0x04d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
    // PhragmenElection
    // If the token decimal changed, this need to be changed too.
    forkedSpec.genesis.raw.top['0xe2e62dd81c48a88f73b6f6463555fd8eba7fb8745735dc3be2a2c61a72c39e78'] = '0x04d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d0010a5d4e800000000000000000000000010a5d4e80000000000000000000000'
    // Council
    forkedSpec.genesis.raw.top['0xaebd463ed9925c488c112434d61debc0ba7fb8745735dc3be2a2c61a72c39e78'] = '0x04d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
  }

  fs.writeFileSync(forkedSpecPath, JSON.stringify(forkedSpec, null, 4));

  console.log('Forked genesis generated successfully. Find it at ./data/fork.json');
  process.exit();
}

main();

const page = 512;
async function fetchChunks(prefix, levelsRemaining, stream, at) {
  if (levelsRemaining <= 0) {
    let keys = await provider.send('state_getKeysPaged', [prefix, page, null, at]);
    let key_count = keys.length;
    if (key_count > 0) {
      total_keys_count += key_count;
      console.log(chalk.green("Keys fetched: " + total_keys_count));
      // const pairs = await provider.send('state_queryStorageAt', [keys, at]);
      const values = await api.rpc.state.queryStorageAt(keys, at)
      if (values.length != keys.length) {
        console.log(chalk.red("values length: " + values.length + " and key length: " + keys.length + " not equal"));
      }
      let pairs = [];

      for (let i = 0; i < keys.length; i++) {
        pairs.push([keys[i], values[i]]);
      }

      separator ? stream.write(",") : separator = true;
      stream.write(JSON.stringify(pairs).slice(1, -1));
    }

    while (key_count == page) {
      total_keys_count += key_count;
      console.log(chalk.green("Keys fetched: " + total_keys_count));
      keys = await provider.send('state_getKeysPaged', [prefix, page, keys[key_count - 1], at]);
      key_count = keys.length;
      if (key_count > 0) {
        // const pairs = await provider.send('state_queryStorageAt', [keys, at]);
        const values = await api.rpc.state.queryStorageAt(keys, at);
        if (values.length != keys.length) {
          console.log(chalk.red("values length: " + values.length + " and key length: " + keys.length + " not equal"));
        }
        let pairs = [];

        for (let i = 0; i < keys.length; i++) {
          pairs.push([keys[i], values[i]]);
        }
        separator ? stream.write(",") : separator = true;
        stream.write(JSON.stringify(pairs).slice(1, -1));
      }
    }

    progressBar.update(++chunksFetched);
    return;
  }

  // Async fetch the last level
  if (process.env.QUICK_MODE && levelsRemaining == 1) {
    let promises = [];
    for (let i = 0; i < 256; i++) {
      promises.push(fetchChunks(prefix + i.toString(16).padStart(2, "0"), levelsRemaining - 1, stream, at));
    }
    await Promise.all(promises);
  } else {
    for (let i = 0; i < 256; i++) {
      await fetchChunks(prefix + i.toString(16).padStart(2, "0"), levelsRemaining - 1, stream, at);
    }
  }
}