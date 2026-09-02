import { ObsidianSyncClient } from './client';

function printUsage(): void {
  console.log(`
Wanxiang Obsidian Sync CLI (v0.2.0)

Usage:
  npx tsx local/obsidian-sync/index.ts <command> [options]

Commands:
  status               Show file sync differences between local vault and cloud
  pull [file-path]     Download file(s) from cloud to local vault
  push [file-path]     Upload file(s) from local vault to cloud
  sync                 Run safe two-way synchronization
  delete <file-path>   Soft-delete a file on cloud
  restore <file-path>  Restore a soft-deleted file on cloud

Options:
  --dry-run            Simulate operations without writing/deleting any files
  --vault <path>       Specify local vault path (or set OBSIDIAN_VAULT_PATH env)
  --server <url>       Specify cloud server URL (or set WANXIANG_SERVER_URL env)
  --token <token>      Specify API Bearer token (or set WANXIANG_API_KEY env)
  --force              Force upload even if base version differs
  --help, -h           Show this help message
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const isDryRun = args.includes('--dry-run');
  const isForce = args.includes('--force');

  const getArgValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const vaultPath = getArgValue('--vault') || process.env.OBSIDIAN_VAULT_PATH || process.env.VAULT_PATH;
  const serverUrl = getArgValue('--server') || process.env.WANXIANG_SERVER_URL || 'https://wanxiang-cloud-dev.mzer8-substracker.workers.dev';
  const apiKey = getArgValue('--token') || process.env.WANXIANG_API_KEY || process.env.API_BEARER_TOKEN;

  if (!vaultPath) {
    console.error('Error: Vault path is required. Provide --vault <path> or set OBSIDIAN_VAULT_PATH.');
    process.exit(1);
  }

  if (!apiKey) {
    console.error('Error: API Key / Token is required. Provide --token <token> or set WANXIANG_API_KEY.');
    process.exit(1);
  }

  const client = new ObsidianSyncClient({
    vaultPath,
    serverUrl,
    apiKey,
    dryRun: isDryRun
  });

  if (isDryRun) {
    console.log('[DRY-RUN MODE ENABLED] No actual file changes will be made.\n');
  }

  try {
    switch (command) {
      case 'status': {
        const statuses = await client.getStatus();
        console.log(`=== Wanxiang Obsidian Sync Status (${statuses.length} files) ===`);
        for (const s of statuses) {
          const detailStr = s.detail ? ` (${s.detail})` : '';
          const cloudVerStr = s.cloudVersion ? ` [v${s.cloudVersion}]` : '';
          console.log(`  ${s.state.padEnd(16)} : ${s.path}${cloudVerStr}${detailStr}`);
        }
        break;
      }

      case 'push': {
        const targetPath = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
        if (targetPath) {
          const res = await client.pushFile(targetPath, { force: isForce });
          console.log(res.message);
          if (!res.success) process.exit(1);
        } else {
          const statuses = await client.getStatus();
          let pushedCount = 0;
          for (const s of statuses) {
            if (s.state === 'local_only' || s.state === 'modified_local') {
              const res = await client.pushFile(s.path, { force: isForce });
              console.log(res.message);
              if (res.success) pushedCount++;
            }
          }
          console.log(`\nPush completed: ${pushedCount} file(s) pushed.`);
        }
        break;
      }

      case 'pull': {
        const targetPath = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
        if (targetPath) {
          const res = await client.pullFile(targetPath);
          console.log(res.message);
          if (!res.success) process.exit(1);
        } else {
          const statuses = await client.getStatus();
          let pulledCount = 0;
          for (const s of statuses) {
            if (s.state === 'cloud_only' || s.state === 'modified_cloud') {
              const res = await client.pullFile(s.path);
              console.log(res.message);
              if (res.success) pulledCount++;
            }
          }
          console.log(`\nPull completed: ${pulledCount} file(s) pulled.`);
        }
        break;
      }

      case 'sync': {
        const res = await client.sync();
        console.log('=== Sync Results ===');
        for (const act of res.actions) {
          console.log(`  ✓ ${act}`);
        }
        if (res.conflicts.length > 0) {
          console.log('\n=== Conflicts / Blockers ===');
          for (const conf of res.conflicts) {
            console.log(`  ✗ ${conf}`);
          }
        }
        console.log(`\nFinished: ${res.actions.length} action(s), ${res.conflicts.length} conflict(s).`);
        break;
      }

      case 'delete': {
        const targetPath = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
        if (!targetPath) {
          console.error('Error: file path required for delete command.');
          process.exit(1);
        }
        const res = await client.deleteCloudFile(targetPath);
        console.log(res.message);
        break;
      }

      case 'restore': {
        const targetPath = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
        if (!targetPath) {
          console.error('Error: file path required for restore command.');
          process.exit(1);
        }
        const res = await client.restoreCloudFile(targetPath);
        console.log(res.message);
        if (!res.success) process.exit(1);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err: unknown) {
    console.error('Execution failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
