#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execSync, spawn, spawnSync } = require('child_process');
const readline = require('readline');

// Color and styling helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  underline: '\x1b[4m',
  
  // Foreground
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  // Background
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgDark: '\x1b[48;5;236m',
};

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVICE_NAME = 'antigravity-mobile-remote.service';
const USER_SYSTEMD_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const USER_SERVICE_FILE = path.join(USER_SYSTEMD_DIR, SERVICE_NAME);
const LOCAL_SERVICE_FILE = path.join(PROJECT_ROOT, SERVICE_NAME);

let rl = null;
const lineQueue = [];
const waitingResolvers = [];

function initRl() {
  if (rl && !rl.closed) return;
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (waitingResolvers.length > 0) {
      const resolve = waitingResolvers.shift();
      resolve(trimmed);
    } else {
      lineQueue.push(trimmed);
    }
  });

  rl.on('close', () => {
    while (waitingResolvers.length > 0) {
      const resolve = waitingResolvers.shift();
      resolve('');
    }
  });
}

function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function promptLine(query) {
  process.stdout.write(query);
  initRl();
  if (lineQueue.length > 0) {
    return Promise.resolve(lineQueue.shift());
  }
  return new Promise((resolve) => {
    waitingResolvers.push(resolve);
  });
}

function waitForKey(message = 'برای بازگشت به منو کلید [Enter] را بزنید...') {
  return promptLine(`\n${c.gray}${message}${c.reset}`);
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

function checkPortListening(port = 7788) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true); // Port is in use (server is listening)
        } else {
          resolve(false);
        }
      })
      .once('listening', () => {
        tester.close(() => {
          resolve(false); // Port is free (server NOT listening)
        });
      })
      .listen(port, '0.0.0.0');
  });
}

function getSystemdStatus() {
  if (process.platform !== 'linux') {
    return { available: false, state: 'not_linux', active: false, enabled: false, message: 'مخصوص سیستم‌عامل لینوکس' };
  }

  try {
    const activeOut = execSync(`systemctl --user is-active ${SERVICE_NAME}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    const enabledOut = execSync(`systemctl --user is-enabled ${SERVICE_NAME}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    
    return {
      available: true,
      state: activeOut, // active, inactive, failed, activating, etc.
      active: activeOut === 'active',
      enabled: enabledOut === 'enabled',
      message: activeOut,
    };
  } catch (err) {
    let state = 'inactive';
    try {
      state = execSync(`systemctl --user is-active ${SERVICE_NAME} 2>&1 || true`).toString().trim();
    } catch {}
    
    let enabled = false;
    try {
      const en = execSync(`systemctl --user is-enabled ${SERVICE_NAME} 2>&1 || true`).toString().trim();
      enabled = en === 'enabled';
    } catch {}

    return {
      available: true,
      state: state || 'unknown',
      active: state === 'active',
      enabled,
      message: state || 'غیرفعال',
    };
  }
}

function getServiceProxy() {
  const targetFile = fs.existsSync(USER_SERVICE_FILE) ? USER_SERVICE_FILE : LOCAL_SERVICE_FILE;
  if (!fs.existsSync(targetFile)) {
    return null;
  }

  try {
    const content = fs.readFileSync(targetFile, 'utf8');
    const match = content.match(/Environment=["']?(?:HTTP_PROXY|ALL_PROXY|http_proxy|all_proxy)=([^"'\r\n]+)/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch {}

  return null;
}

function getSystemDetectedProxy() {
  const candidates = [
    process.env.HTTP_PROXY,
    process.env.HTTPS_PROXY,
    process.env.ALL_PROXY,
    process.env.http_proxy,
    process.env.https_proxy,
    process.env.all_proxy,
  ];

  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }

  const stateFile = path.join(os.homedir(), '.config', 'proxy_state');
  if (fs.existsSync(stateFile)) {
    try {
      const content = fs.readFileSync(stateFile, 'utf8').trim();
      if (content) return content;
    } catch {}
  }

  return null;
}

function saveServiceFile(proxyUrl = null) {
  if (!fs.existsSync(USER_SYSTEMD_DIR)) {
    fs.mkdirSync(USER_SYSTEMD_DIR, { recursive: true });
  }

  const nodeBin = process.execPath;
  const cliPath = path.join(PROJECT_ROOT, 'dist', 'cli.js');

  let envLines = [
    'Environment=PORT=7788',
    'Environment=NODE_ENV=production',
  ];

  if (proxyUrl && proxyUrl.trim()) {
    const p = proxyUrl.trim();
    const noProxy = 'localhost,127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12';
    envLines.push(`Environment="HTTP_PROXY=${p}"`);
    envLines.push(`Environment="HTTPS_PROXY=${p}"`);
    envLines.push(`Environment="ALL_PROXY=${p}"`);
    envLines.push(`Environment="http_proxy=${p}"`);
    envLines.push(`Environment="https_proxy=${p}"`);
    envLines.push(`Environment="all_proxy=${p}"`);
    envLines.push(`Environment="NO_PROXY=${noProxy}"`);
    envLines.push(`Environment="no_proxy=${noProxy}"`);
  }

  const content = `[Unit]
Description=Antigravity Mobile Remote Server (Standalone LAN Controller)
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${nodeBin} ${cliPath}
Restart=always
RestartSec=3
${envLines.join('\n')}

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(USER_SERVICE_FILE, content, 'utf8');
  try {
    fs.writeFileSync(LOCAL_SERVICE_FILE, content, 'utf8');
  } catch {}

  // Reload systemd daemon
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
  } catch (err) {
    console.error(`${c.red}خطا در اجرای daemon-reload: ${err.message}${c.reset}`);
  }
}

async function renderHeader() {
  const lanIp = getLanIp();
  const sysd = getSystemdStatus();
  const portListening = await checkPortListening(7788);
  const serviceProxy = getServiceProxy();
  const systemProxy = getSystemDetectedProxy();

  console.clear();
  console.log(`${c.cyan}╔═══════════════════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.cyan}║${c.reset}  ${c.bold}${c.magenta}📱 Antigravity Mobile Remote — TUI کنترل و مدیریت پیشرفته${c.reset}          ${c.cyan}║${c.reset}`);
  console.log(`${c.cyan}╚═══════════════════════════════════════════════════════════════════════╝${c.reset}`);

  // Server & Service status badges
  let statusBadge = '';
  if (sysd.active) {
    statusBadge = `${c.green}${c.bold}● فعال در پس‌زمینه (systemd Active)${c.reset}`;
  } else if (portListening) {
    statusBadge = `${c.green}${c.bold}● فعال در ترمینال / پورت 7788 در حال شنود${c.reset}`;
  } else if (sysd.state === 'failed') {
    statusBadge = `${c.red}${c.bold}✖ خطا داده (Failed)${c.reset}`;
  } else {
    statusBadge = `${c.gray}○ غیرفعال (متوقف)${c.reset}`;
  }

  const autostartBadge = sysd.enabled
    ? `${c.green}فعال (Enabled)${c.reset}`
    : `${c.yellow}غیرفعال (Disabled)${c.reset}`;

  const proxyBadge = serviceProxy
    ? `${c.green}${serviceProxy}${c.reset}`
    : `${c.yellow}تنظیم نشده (اتصال مستقیم)${c.reset}`;

  const sysProxyBadge = systemProxy
    ? `${c.cyan}${systemProxy}${c.reset}`
    : `${c.gray}یافت نشد${c.reset}`;

  console.log(` ${c.bold}وضعیت سرویس:${c.reset}       ${statusBadge}`);
  console.log(` ${c.bold}شروع خودکار (بوت):${c.reset}  ${autostartBadge}`);
  console.log(` ${c.bold}پروکسی سرویس:${c.reset}      ${proxyBadge}`);
  console.log(` ${c.bold}پروکسی سیستم:${c.reset}      ${sysProxyBadge}`);
  console.log(` ${c.bold}آدرس شبکه محلی:${c.reset}    ${c.cyan}${c.bold}http://${lanIp}:7788${c.reset}`);
  console.log(`${c.gray}─────────────────────────────────────────────────────────────────────────${c.reset}`);
}

function executeInteractiveCommand(cmd, args) {
  closeRl();

  // Temporary ignore SIGINT in parent so child handles it cleanly
  const onSigInt = () => {};
  process.on('SIGINT', onSigInt);

  try {
    spawnSync(cmd, args, {
      stdio: 'inherit',
      cwd: PROJECT_ROOT,
    });
  } catch (err) {
    console.error(`${c.red}خطا در اجرای فرآیند:${c.reset}`, err.message);
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }
}

async function handleStartNow() {
  const isListening = await checkPortListening(7788);
  if (isListening) {
    console.log(`\n${c.yellow}⚠ پورت 7788 در حال حاضر اشغال است (احتمالاً سرویس پس‌زمینه روشن است).${c.reset}`);
    const stopFirst = await promptLine('آیا مایلید ابتدا سرویس پس‌زمینه متوقف شود؟ [Y/n] ');
    if (stopFirst.toLowerCase() !== 'n') {
      try {
        execSync(`systemctl --user stop ${SERVICE_NAME}`);
        console.log(`${c.green}✓ سرویس پس‌زمینه متوقف شد.${c.reset}`);
      } catch (err) {
        console.log(`${c.red}خطا در توقف سرویس: ${err.message}${c.reset}`);
      }
    }
  }

  const cliPath = path.join(PROJECT_ROOT, 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    console.log(`\n${c.yellow}فایل dist/cli.js یافت نشد. در حال بیلد پروژه...${c.reset}`);
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  }

  console.log(`\n${c.cyan}🚀 در حال راه‌اندازی Antigravity Mobile Remote در ترمینال...${c.reset}`);
  console.log(`${c.gray}(برای توقف و بازگشت به این منو، کلید [q] یا [Ctrl+C] را فشار دهید)${c.reset}\n`);

  executeInteractiveCommand(process.execPath, [cliPath]);
  await waitForKey();
}

async function handleStartService() {
  console.log(`\n${c.cyan}▶ در حال راه‌اندازی سرویس systemd...${c.reset}`);
  try {
    if (!fs.existsSync(USER_SERVICE_FILE)) {
      console.log(`${c.yellow}فایل سرویس در مسیر کاربر یافت نشد. در حال ساخت اولیه...${c.reset}`);
      const sysProxy = getSystemDetectedProxy();
      saveServiceFile(sysProxy);
    }
    execSync(`systemctl --user start ${SERVICE_NAME}`);
    console.log(`${c.green}✓ سرویس با موفقیت راه‌اندازی شد.${c.reset}`);
  } catch (err) {
    console.log(`${c.red}✗ خطا در راه‌اندازی سرویس:${c.reset} ${err.message}`);
  }
  await waitForKey();
}

async function handleStopService() {
  console.log(`\n${c.yellow}⏹ در حال متوقف‌سازی سرویس systemd...${c.reset}`);
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`);
    console.log(`${c.green}✓ سرویس با موفقیت متوقف شد.${c.reset}`);
  } catch (err) {
    console.log(`${c.red}✗ خطا در توقف سرویس:${c.reset} ${err.message}`);
  }
  await waitForKey();
}

async function handleRestartService() {
  console.log(`\n${c.cyan}🔄 در حال ری‌استارت سرویس systemd...${c.reset}`);
  try {
    execSync(`systemctl --user restart ${SERVICE_NAME}`);
    console.log(`${c.green}✓ سرویس با موفقیت ری‌استارت شد.${c.reset}`);
  } catch (err) {
    console.log(`${c.red}✗ خطا در ری‌استارت سرویس:${c.reset} ${err.message}`);
  }
  await waitForKey();
}

async function handleViewLogs() {
  console.log(`\n${c.cyan}📜 لاگ‌های زنده سرویس (برای خروج و بازگشت، کلید Ctrl+C را بزنید):${c.reset}\n`);
  executeInteractiveCommand('journalctl', ['--user', '-u', SERVICE_NAME, '-f', '-n', '35', '--no-pager']);
  await waitForKey();
}

async function handleConfigureProxy() {
  const currentServiceProxy = getServiceProxy();
  const systemDetectedProxy = getSystemDetectedProxy();

  console.clear();
  console.log(`${c.cyan}╔═══════════════════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.cyan}║${c.reset}  ${c.bold}${c.magenta}🌐 تنظیم و اصلاح پروکسی سرویس Antigravity Remote${c.reset}                     ${c.cyan}║${c.reset}`);
  console.log(`${c.cyan}╚═══════════════════════════════════════════════════════════════════════╝${c.reset}\n`);

  console.log(`• ${c.bold}پروکسی فعلی ثبت‌شده در سرویس:${c.reset} ${currentServiceProxy ? `${c.green}${currentServiceProxy}${c.reset}` : `${c.yellow}تنظیم نشده (بدون پروکسی)${c.reset}`}`);
  console.log(`• ${c.bold}پروکسی شناسایی‌شده در سیستم:${c.reset}   ${systemDetectedProxy ? `${c.cyan}${systemDetectedProxy}${c.reset}` : `${c.gray}پروکسی در متغیرهای سیستمی یافت نشد${c.reset}`}\n`);

  console.log(`${c.bold}گزینه‌های تنظیم پروکسی:${c.reset}`);
  if (systemDetectedProxy) {
    console.log(`  ${c.cyan}[1]${c.reset} اعمال پروکسی شناسایی‌شده سیستم (${c.bold}${systemDetectedProxy}${c.reset})`);
  } else {
    console.log(`  ${c.dim}[1] اعمال پروکسی شناسایی‌شده سیستم (در دسترس نیست)${c.reset}`);
  }
  console.log(`  ${c.cyan}[2]${c.reset} وارد کردن نشانی دستی پروکسی (مانند socks5h://127.0.0.1:10808 یا http://127.0.0.1:2080)`);
  console.log(`  ${c.cyan}[3]${c.reset} غیرفعال‌سازی و حذف پروکسی از سرویس (اتصال مستقیم Direct)`);
  console.log(`  ${c.gray}[0] بازگشت بدون تغییر${c.reset}\n`);

  const choice = await promptLine('شماره گزینه مورد نظر: ');

  let newProxy = null;
  let shouldUpdate = false;

  if (choice === '1' && systemDetectedProxy) {
    newProxy = systemDetectedProxy;
    shouldUpdate = true;
  } else if (choice === '2') {
    const inputProxy = await promptLine('\nنشانی پروکسی را وارد کنید (مثال: socks5h://127.0.0.1:10808): ');
    if (inputProxy) {
      newProxy = inputProxy;
      shouldUpdate = true;
    } else {
      console.log(`${c.yellow}ورودی خالی بود. تغییری اعمال نشد.${c.reset}`);
    }
  } else if (choice === '3') {
    newProxy = null;
    shouldUpdate = true;
  } else if (choice === '0') {
    return;
  } else {
    console.log(`${c.red}گزینه نامعتبر است.${c.reset}`);
  }

  if (shouldUpdate) {
    console.log(`\n${c.cyan}در حال به‌روزرسانی پیکربندی سرویس...${c.reset}`);
    saveServiceFile(newProxy);
    console.log(`${c.green}✓ فایل سرویس با موفقیت به‌روزرسانی شد و daemon-reload انجام گرفت.${c.reset}`);

    const sysd = getSystemdStatus();
    if (sysd.active) {
      const doRestart = await promptLine('\nسرویس در حال اجراست. آیا مایلید سرویس هم‌اکنون با پروکسی جدید ری‌استارت شود؟ [Y/n] ');
      if (doRestart.toLowerCase() !== 'n') {
        try {
          execSync(`systemctl --user restart ${SERVICE_NAME}`);
          console.log(`${c.green}✓ سرویس با موفقیت با پروکسی جدید ری‌استارت شد.${c.reset}`);
        } catch (err) {
          console.log(`${c.red}خطا در ری‌استارت سرویس: ${err.message}${c.reset}`);
        }
      }
    }
  }

  await waitForKey();
}

async function handleFullInstall() {
  console.clear();
  console.log(`${c.cyan}╔═══════════════════════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.cyan}║${c.reset}  ${c.bold}${c.magenta}🛠️  نصب، کامپایل و پیکربندی مجدد کامل پروژه${c.reset}                          ${c.cyan}║${c.reset}`);
  console.log(`${c.cyan}╚═══════════════════════════════════════════════════════════════════════╝${c.reset}\n`);

  try {
    console.log(`${c.cyan}۱. نصب وابستگی‌های پکیج‌ها (npm install)...${c.reset}`);
    execSync('npm install', { cwd: PROJECT_ROOT, stdio: 'inherit' });

    console.log(`\n${c.cyan}۲. کامپایل و بیلد سورس‌ها (npm run build)...${c.reset}`);
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });

    console.log(`\n${c.cyan}۳. ثبت دستور سراسری antigravity-remote (npm link)...${c.reset}`);
    try {
      execSync('npm link', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    } catch (err) {
      console.log(`${c.yellow}نکته: npm link ممکن است نیاز به مجوز کاربر داشته باشد: ${err.message}${c.reset}`);
    }

    console.log(`\n${c.cyan}۴. پیکربندی و ثبت سرویس systemd...${c.reset}`);
    const sysProxy = getSystemDetectedProxy();
    saveServiceFile(sysProxy);
    execSync(`systemctl --user enable ${SERVICE_NAME}`);
    console.log(`${c.green}✓ سرویس در systemd فعال و ثبت گردید.${c.reset}`);

    console.log(`\n${c.green}${c.bold}🎉 تمام مراحل با موفقیت به پایان رسید!${c.reset}`);
  } catch (err) {
    console.error(`\n${c.red}خطا در مراحل نصب: ${err.message}${c.reset}`);
  }

  await waitForKey();
}

async function handleToggleAutostart() {
  const sysd = getSystemdStatus();
  console.log(`\n${c.cyan}وضعیت فعلی شروع خودکار:${c.reset} ${sysd.enabled ? 'فعال (Enabled)' : 'غیرفعال (Disabled)'}`);

  try {
    if (sysd.enabled) {
      execSync(`systemctl --user disable ${SERVICE_NAME}`);
      console.log(`${c.yellow}✓ شروع خودکار سرویس در بوت سیستم غیرفعال شد.${c.reset}`);
    } else {
      execSync(`systemctl --user enable ${SERVICE_NAME}`);
      console.log(`${c.green}✓ شروع خودکار سرویس در بوت سیستم فعال شد.${c.reset}`);
    }
  } catch (err) {
    console.log(`${c.red}خطا: ${err.message}${c.reset}`);
  }

  await waitForKey();
}

async function mainLoop() {
  while (true) {
    await renderHeader();

    console.log(` ${c.bold}عملیات‌های در دسترس:${c.reset}`);
    console.log(`   ${c.cyan}[1]${c.reset} 🚀 ${c.bold}استارت الان${c.reset} (اجرای مستقیم در همین ترمینال / Foreground)`);
    console.log(`   ${c.cyan}[2]${c.reset} ▶️  ${c.bold}استارت سرویس پس‌زمینه${c.reset} (systemd start)`);
    console.log(`   ${c.cyan}[3]${c.reset} ⏹️  ${c.bold}استاپ سرویس پس‌زمینه${c.reset} (systemd stop)`);
    console.log(`   ${c.cyan}[4]${c.reset} 🔄 ${c.bold}ری‌استارت سرویس پس‌زمینه${c.reset} (systemd restart)`);
    console.log(`   ${c.cyan}[5]${c.reset} 📜 ${c.bold}مشاهده لاگ‌های زنده سرویس${c.reset} (journalctl -f)`);
    console.log(`   ${c.cyan}[6]${c.reset} 🌐 ${c.bold}اصلاح و تنظیم پروکسی سرویس${c.reset} (Proxy Config)`);
    console.log(`   ${c.cyan}[7]${c.reset} 🛠️  ${c.bold}نصب و بازسازی مجدد کامل${c.reset} (Install, Build, Link)`);
    console.log(`   ${c.cyan}[8]${c.reset} ⚙️  ${c.bold}سوئیچ شروع خودکار در بوت${c.reset} (Enable/Disable Autostart)`);
    console.log(`   ${c.gray}[0] ❌ خروج${c.reset}\n`);

    const answer = await promptLine(`${c.bold}شماره گزینه مورد نظر را وارد کنید: ${c.reset}`);

    switch (answer.trim()) {
      case '1':
        await handleStartNow();
        break;
      case '2':
        await handleStartService();
        break;
      case '3':
        await handleStopService();
        break;
      case '4':
        await handleRestartService();
        break;
      case '5':
        await handleViewLogs();
        break;
      case '6':
        await handleConfigureProxy();
        break;
      case '7':
        await handleFullInstall();
        break;
      case '8':
        await handleToggleAutostart();
        break;
      case '0':
      case 'exit':
      case 'quit':
      case 'q':
        console.log(`\n${c.magenta}👋 خدانگهدار!${c.reset}\n`);
        process.exit(0);
      default:
        // Ignore or short pause
        break;
    }
  }
}

mainLoop().catch((err) => {
  console.error(`\n${c.red}[TUI Error]:${c.reset}`, err);
  process.exit(1);
});
