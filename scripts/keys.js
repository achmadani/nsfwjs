require('dotenv').config();

const KeyStore = require('../src/keyStore');

const store = new KeyStore(process.env.API_KEYS_FILE || 'data/api-keys.json');
const [command, ...args] = process.argv.slice(2);

function usage() {
  console.log(`Usage:
  npm run keys -- create "<name>"     Buat key baru untuk user/aplikasi
  npm run keys -- list                Tampilkan semua key
  npm run keys -- revoke <id|name>    Nonaktifkan key

File: ${store.filePath}`);
}

try {
  if (command === 'create') {
    const name = args.join(' ');
    const { key, entry } = store.create(name);
    console.log(`Created key for "${entry.name}" (id: ${entry.id})`);
    console.log('');
    console.log(`  ${key}`);
    console.log('');
    console.log('Simpan key ini sekarang. Key tidak bisa ditampilkan lagi.');
  } else if (command === 'list') {
    const keys = store.list();
    if (keys.length === 0) {
      console.log('No keys yet.');
    } else {
      console.table(keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: `${key.prefix}...`,
        status: key.active ? 'active' : 'revoked',
        created_at: key.created_at,
        revoked_at: key.revoked_at || ''
      })));
    }
  } else if (command === 'revoke') {
    const target = args.join(' ');
    if (!target) {
      usage();
      process.exitCode = 1;
    } else {
      const revoked = store.revoke(target);
      if (!revoked) {
        console.error(`Active key "${target}" not found.`);
        process.exitCode = 1;
      } else {
        console.log(`Revoked key "${revoked.name}" (id: ${revoked.id}).`);
      }
    }
  } else {
    usage();
    if (command) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
