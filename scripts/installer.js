#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execSync, spawn } = require('child_process');
const readline = require('readline');

// Color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, defaultVal = 'y') {
  if (rl.closed) {
    return Promise.resolve(defaultVal.toLowerCase() === 'y');
  }
  return new Promise((resolve) => {
    let resolved = false;
    const onLine = (answer) => {
      if (resolved) return;
      resolved = true;
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) {
        resolve(defaultVal.toLowerCase() === 'y');
      } else {
        resolve(trimmed === 'y' || trimmed === 'yes' || trimmed === 'بله' || trimmed === 'آره');
      }
    };

    const onClose = () => {
      if (resolved) return;
      resolved = true;
      resolve(defaultVal.toLowerCase() === 'y');
    };

    rl.once('close', onClose);
    rl.question(`${colors.bright}${question}${colors.reset} `, (answer) => {
      rl.removeListener('close', onClose);
      onLine(answer);
    });
  });
}

function printHeader() {
  console.clear();
  console.log(`${colors.cyan}╔═══════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║${colors.reset}   ${colors.bright}${colors.magenta}📱 منوی نصب و راه‌اندازی Antigravity Mobile Remote${colors.reset}         ${colors.cyan}║${colors.reset}`);
  console.log(`${colors.cyan}║${colors.reset}   ${colors.dim}برنامه مستقل ترمینال‌محور و کراس‌پلتفرم (ویندوز / لینوکس)${colors.reset}      ${colors.cyan}║${colors.reset}`);
  console.log(`${colors.cyan}╚═══════════════════════════════════════════════════════════════╝${colors.reset}\n`);
}

function checkNodeVersion() {
  const current = process.version;
  const major = parseInt(current.slice(1).split('.')[0], 10);
  const ok = major >= 18;
  return {
    name: 'Node.js',
    version: current,
    ok,
    message: ok
      ? `${colors.green}✓ ${current} (مناسب)${colors.reset}`
      : `${colors.red}✗ نسخه فعلی ${current} است. حداقل نسخه ۱۸ الزامی است.${colors.reset}`,
  };
}

function checkNpm() {
  try {
    const isWin = process.platform === 'win32';
    const npmCmd = isWin ? 'npm.cmd -v' : 'npm -v';
    const version = execSync(npmCmd, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    return {
      name: 'npm Package Manager',
      version,
      ok: true,
      message: `${colors.green}✓ نسخه ${version}${colors.reset}`,
    };
  } catch {
    return {
      name: 'npm Package Manager',
      ok: false,
      message: `${colors.red}✗ npm یافت نشد.${colors.reset}`,
    };
  }
}

function checkAgy() {
  const isWin = process.platform === 'win32';
  const home = os.homedir();

  const miseShim = isWin
    ? path.join(home, '.local', 'share', 'mise', 'shims', 'agy.cmd')
    : path.join(home, '.local', 'share', 'mise', 'shims', 'agy');

  if (fs.existsSync(miseShim)) {
    return {
      ok: true,
      path: miseShim,
      message: `${colors.green}✓ یافت شد (Mise Shim): ${miseShim}${colors.reset}`,
    };
  }

  const localBin = isWin
    ? path.join(home, 'AppData', 'Roaming', 'npm', 'agy.cmd')
    : path.join(home, '.local', 'bin', 'agy');

  if (fs.existsSync(localBin)) {
    return {
      ok: true,
      path: localBin,
      message: `${colors.green}✓ یافت شد: ${localBin}${colors.reset}`,
    };
  }

  try {
    const checker = isWin ? 'where agy' : 'which agy';
    const out = execSync(checker, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (out) {
      const firstLine = out.split(/\r?\n/)[0].trim();
      return {
        ok: true,
        path: firstLine,
        message: `${colors.green}✓ یافت شد در PATH: ${firstLine}${colors.reset}`,
      };
    }
  } catch {
    // Ignore
  }

  return {
    ok: false,
    message: `${colors.yellow}⚠ ابزار agy در PATH یافت نشد.${colors.reset}\n    ${colors.gray}(نکته: در صورت نصب بودن Antigravity IDE یا CLI، مسیر آن را به متغیر PATH اضافه کنید)${colors.reset}`,
  };
}

function checkPort(port = 7788) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve({
            ok: false,
            port,
            message: `${colors.yellow}⚠ پورت ${port} در حال حاضر توسط پروسه دیگری استفاده می‌شود.${colors.reset}`,
          });
        } else {
          resolve({
            ok: false,
            port,
            message: `${colors.red}✗ خطای پورت: ${err.message}${colors.reset}`,
          });
        }
      })
      .once('listening', () => {
        tester.close(() => {
          resolve({
            ok: true,
            port,
            message: `${colors.green}✓ پورت ${port} آزاد و آماده استفاده است.${colors.reset}`,
          });
        });
      })
      .listen(port, '0.0.0.0');
  });
}

function getLanIp() {
  const interfaces = os.networkInterfaces();
  const virtualNames = [
    'docker', 'br-', 'veth', 'vethernet', 'wsl', 'virtualbox', 'vmware',
    'hyper-v', 'tap', 'tun', 'utun', 'tailscale', 'zerotier', 'loopback', 'dummy'
  ];

  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    if (virtualNames.some((v) => lower.includes(v))) continue;
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        if (addr.address.startsWith('192.168.')) {
          return addr.address;
        }
      }
    }
  }

  // Secondary check for other private IPs
  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    if (virtualNames.some((v) => lower.includes(v))) continue;
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }

  return '127.0.0.1';
}

async function runStep(title, fn) {
  process.stdout.write(`${colors.cyan}▶ ${title}...${colors.reset} `);
  try {
    await fn();
    console.log(`${colors.green}انجام شد ✓${colors.reset}`);
    return true;
  } catch (err) {
    console.log(`${colors.red}خطا رخ داد ✗${colors.reset}`);
    console.error(err.message || err);
    return false;
  }
}

async function main() {
  printHeader();

  console.log(`${colors.bright}🔍 گام ۱: بررسی خودکار پیش‌نیازهای سیستم${colors.reset}`);
  console.log(`${colors.gray}─────────────────────────────────────────────────────────────${colors.reset}`);

  // 1. Check Node
  const nodeCheck = checkNodeVersion();
  console.log(`• ${colors.bright}محیط Node.js:${colors.reset}    ${nodeCheck.message}`);
  if (!nodeCheck.ok) {
    console.log(`\n${colors.red}لطفا ابتدا Node.js نسخه ۱۸ به بالا را نصب کنید.${colors.reset}`);
    rl.close();
    process.exit(1);
  }

  // 2. Check npm
  const npmCheck = checkNpm();
  console.log(`• ${colors.bright}مدیر پکیج npm:${colors.reset}  ${npmCheck.message}`);
  if (!npmCheck.ok) {
    console.log(`\n${colors.red}لطفا ابتدا npm را روی سیستم خود نصب نمایید.${colors.reset}`);
    rl.close();
    process.exit(1);
  }

  // 3. Check agy
  const agyCheck = checkAgy();
  console.log(`• ${colors.bright}موتور ایجنت agy:${colors.reset} ${agyCheck.message}`);

  // 4. Check Port 7788
  const portCheck = await checkPort(7788);
  console.log(`• ${colors.bright}پورت سرور (7788):${colors.reset} ${portCheck.message}`);

  // 5. LAN IP info
  const lanIp = getLanIp();
  console.log(`• ${colors.bright}آدرس شبکه محلی:${colors.reset} ${colors.cyan}http://${lanIp}:7788${colors.reset}`);

  console.log(`${colors.gray}─────────────────────────────────────────────────────────────${colors.reset}\n`);

  // Prompt 1: Install Dependencies
  const doInstall = await ask('آیا مایل به نصب وابستگی‌های پروژه (npm install) هستید؟ [Y/n]', 'y');
  if (doInstall) {
    const isWin = process.platform === 'win32';
    const npmCmd = isWin ? 'npm.cmd' : 'npm';
    await runStep('نصب پکیج‌های npm', () => {
      execSync(`${npmCmd} install`, { stdio: ['ignore', 'inherit', 'inherit'], cwd: path.resolve(__dirname, '..') });
    });
  }

  // Prompt 2: Build Project
  const doBuild = await ask('\nآیا مایل به کامپایل و بیلد پروژه (npm run build) هستید؟ [Y/n]', 'y');
  if (doBuild) {
    const isWin = process.platform === 'win32';
    const npmCmd = isWin ? 'npm.cmd' : 'npm';
    await runStep('بیلد پروژه با esbuild', () => {
      execSync(`${npmCmd} run build`, { stdio: ['ignore', 'inherit', 'inherit'], cwd: path.resolve(__dirname, '..') });
    });
  }

  // Prompt 3: Global CLI Command (npm link)
  const doLink = await ask('\nآیا مایلید دستور سراسری antigravity-remote ایجاد شود تا از هر مسیری در ترمینال قابل اجرا باشد؟ (npm link) [Y/n]', 'y');
  if (doLink) {
    const isWin = process.platform === 'win32';
    const npmCmd = isWin ? 'npm.cmd' : 'npm';
    await runStep('ثبت دستور سراسری antigravity-remote', () => {
      execSync(`${npmCmd} link`, { stdio: ['ignore', 'inherit', 'inherit'], cwd: path.resolve(__dirname, '..') });
    });
  }

  // Prompt 4: OS-Specific Background Service / Startup
  if (process.platform === 'linux') {
    const doService = await ask('\nآیا مایل به نصب و فعال‌سازی سرویس پس‌زمینه systemd کاربر (systemd --user) هستید؟ [y/N]', 'n');
    if (doService) {
      await runStep('پیکربندی سرویس systemd', () => {
        const userSystemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
        if (!fs.existsSync(userSystemdDir)) {
          fs.mkdirSync(userSystemdDir, { recursive: true });
        }
        const serviceFile = path.join(userSystemdDir, 'antigravity-mobile-remote.service');
        const projectRoot = path.resolve(__dirname, '..');
        const nodeBin = process.execPath;
        const cliPath = path.join(projectRoot, 'dist', 'cli.js');

        const serviceContent = `[Unit]
Description=Antigravity Mobile Remote Server (Standalone LAN Controller)
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
ExecStart=${nodeBin} ${cliPath}
Restart=always
RestartSec=3
Environment=PORT=7788
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
        fs.writeFileSync(serviceFile, serviceContent, 'utf8');
        execSync('systemctl --user daemon-reload');
        execSync('systemctl --user enable antigravity-mobile-remote.service');
        console.log(`\n${colors.green}✓ سرویس با موفقیت ثبت شد.${colors.reset}`);
        console.log(`${colors.gray}برای شروع: systemctl --user start antigravity-mobile-remote${colors.reset}`);
        console.log(`${colors.gray}برای وضعیت: systemctl --user status antigravity-mobile-remote${colors.reset}`);
      });
    }
  } else if (process.platform === 'win32') {
    const doShortcut = await ask('\nآیا مایل به ساخت فایل اجرایی سریع (run-remote.bat) در پوشه پروژه هستید؟ [Y/n]', 'y');
    if (doShortcut) {
      await runStep('ایجاد اسکریپت اجرایی ویندوز', () => {
        const projectRoot = path.resolve(__dirname, '..');
        const batPath = path.join(projectRoot, 'run-remote.bat');
        const batContent = `@echo off\r\ntitle Antigravity Mobile Remote\r\ncd /d "%~dp0"\r\nnode dist\\cli.js\r\npause\r\n`;
        fs.writeFileSync(batPath, batContent, 'utf8');
        console.log(`\n${colors.green}✓ فایل run-remote.bat ایجاد شد.${colors.reset}`);
      });
    }
  }

  // Prompt 5: Launch Now
  console.log(`\n${colors.green}🎉 راه‌اندازی و پیکربندی با موفقیت انجام شد!${colors.reset}\n`);
  const doRun = await ask('آیا مایلید Antigravity Mobile Remote هم‌اکنون در ترمینال اجرا شود؟ [Y/n]', 'y');

  rl.close();

  if (doRun) {
    const launchPort = portCheck.ok ? 7788 : 7789;
    if (!portCheck.ok) {
      console.log(`${colors.yellow}پورت 7788 درگیر است، سرور روی پورت جایگزین ${launchPort} اجرا می‌شود...${colors.reset}`);
    }
    console.log(`\n${colors.cyan}در حال اجرای سرور روی پورت ${launchPort}...${colors.reset}\n`);
    const cliPath = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const child = spawn(process.execPath, [cliPath, '-p', launchPort.toString()], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  } else {
    console.log(`\n${colors.bright}برای اجرای برنامه در آینده می‌توانید از دستورات زیر استفاده کنید:${colors.reset}`);
    console.log(`  ${colors.cyan}npm start${colors.reset}   یا   ${colors.cyan}antigravity-remote${colors.reset}\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`${colors.red}[Installer Error]:${colors.reset}`, err);
  rl.close();
  process.exit(1);
});
