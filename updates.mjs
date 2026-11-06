import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const branchRef = 'https://api.github.com/repos/renyuxiao9-source/mort1s/git/ref/heads/main';
const projectRoot = fileURLToPath(new URL('./', import.meta.url));
const runFile = promisify(execFile);
const isCommit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

async function installedCommit() {
  try {
    const { stdout } = await runFile('git', ['rev-parse', '--show-prefix', 'HEAD'], {
      cwd: projectRoot, timeout: 2000, maxBuffer: 4096, windowsHide: true,
    });
    const [prefix, commit] = stdout.split(/\r?\n/);
    return prefix === '' && isCommit(commit) ? commit : null;
  } catch {
    return null;
  }
}

export function createUpdateChecker(installed = installedCommit()) {
  let pending;

  async function check() {
    const local = await installed;
    let latest = null;
    try {
      const response = await fetch(branchRef, {
        headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
        redirect: 'error',
        signal: AbortSignal.timeout(4500),
      });
      if (response.ok) {
        const data = await response.json();
        if (isCommit(data?.object?.sha)) latest = data.object.sha;
      }
    } catch {
      // A failed check leaves the gateway and its configuration usable offline.
    }

    let status;
    let message;
    if (!latest) {
      status = 'unavailable';
      message = '暂时无法读取 GitHub 上的版本。可以稍后重试。';
    } else if (!local) {
      status = 'unknown';
      message = `GitHub main 为 ${latest.slice(0, 7)}。当前安装没有可识别的 Git 提交。`;
    } else if (local === latest) {
      status = 'current';
      message = `当前版本 ${local.slice(0, 7)} 与 GitHub main 一致。`;
    } else {
      status = 'different';
      message = `当前版本 ${local.slice(0, 7)}，GitHub main 为 ${latest.slice(0, 7)}。可在项目目录运行 git pull --ff-only，再重启网关。`;
    }
    return { status, message, local, latest };
  }

  return () => {
    pending ??= check().finally(() => { pending = undefined; });
    return pending;
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await createUpdateChecker()();
  console.log(`汇流 · ${result.message}`);
}
