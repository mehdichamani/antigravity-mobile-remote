import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import * as QRCode from 'qrcode';
import { RemoteServer, resolveAgyBinary, openInDefaultBrowser } from './server';

interface CliArgs {
  port: number;
  workspace: string;
  effort: string;
  openBrowser: boolean;
  showQr: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    port: parseInt(process.env.PORT || '7788', 10),
    workspace: process.cwd(),
    effort: process.env.EFFORT || 'low',
    openBrowser: false,
    showQr: true,
    help: false,
    version: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-p' || arg === '--port') {
      const next = args[++i];
      if (next && !isNaN(parseInt(next, 10))) {
        result.port = parseInt(next, 10);
      }
    } else if (arg === '-w' || arg === '--workspace' || arg === '-d' || arg === '--dir') {
      const next = args[++i];
      if (next) {
        result.workspace = path.resolve(next);
      }
    } else if (arg === '-e' || arg === '--effort') {
      const next = args[++i];
      if (next && ['low', 'medium', 'high'].includes(next.toLowerCase())) {
        result.effort = next.toLowerCase();
      }
    } else if (arg === '-o' || arg === '--open') {
      result.openBrowser = true;
    } else if (arg === '--no-qr') {
      result.showQr = false;
    } else if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (arg === '-v' || arg === '--version') {
      result.version = true;
    }
  }

  return result;
}

function showHelp() {
  console.log(`
📱 Antigravity Mobile Remote (CLI)
======================================================
کنترل و نظارت محلی بر ایجنت Antigravity از طریق گوشی موبایل

دستورات و سوییچ‌ها:
  -p, --port <number>          پورت سرور محلی (پیش‌فرض: 7788)
  -w, --workspace <path>       مسیر دایرکتوری کاری برای اجرای فرامین ایجنت (پیش‌فرض: مسیر جاری)
  -d, --dir <path>             نام مستعار برای --workspace
  -e, --effort <level>         سطح استدلال ایجنت: low | medium | high (پیش‌فرض: low)
  -o, --open                   باز کردن خودکار آدرس در مرورگر پیش‌فرض سیستم
      --no-qr                  عدم نمایش کد QR در خروجی ترمینال
  -v, --version                نمایش شماره نسخه
  -h, --help                   نمایش این راهنما

کلیدهای میانبر در حین اجرا (Interactive Shortcuts):
  [r]  چاپ مجدد کد QR و آدرس‌های اتصال
  [o]  باز کردن آدرس وب در مرورگر دسکتاپ
  [c]  پاکسازی تاریخچه گفتگوها
  [s]  نمایش وضعیت فعلی سرور و تعداد کلاینت‌ها
  [w]  نمایش دایرکتوری کاری فعال
  [h]  نمایش راهنمای کلیدها
  [q]  خروج و خاموش‌سازی سرور (یا Ctrl+C)
`);
}

async function printBanner(server: RemoteServer, options: { showQr: boolean; effort: string; workspace: string }) {
  const url = server.getUrl();
  const lanIp = server.getLanIp();
  const agy = resolveAgyBinary();

  console.log('\n\x1b[36m┌─────────────────────────────────────────────────────────────┐\x1b[0m');
  console.log('\x1b[36m│\x1b[0m   \x1b[1m\x1b[35m📱 Antigravity Mobile Remote\x1b[0m  \x1b[32m[v1.0.0 Standalone CLI]\x1b[0m       \x1b[36m│\x1b[0m');
  console.log('\x1b[36m└─────────────────────────────────────────────────────────────┘\x1b[0m');
  console.log(`📡 URL:        \x1b[1m\x1b[36m${url}\x1b[0m`);
  console.log(`💻 LAN IP:     \x1b[32m${lanIp}\x1b[0m`);
  console.log(`📂 Workspace:  \x1b[33m${options.workspace}\x1b[0m`);
  console.log(`⚙️  Effort:     \x1b[35m${options.effort}\x1b[0m`);

  if (agy.exists) {
    console.log(`🤖 Engine:     \x1b[32m✓ agy detected\x1b[0m (${agy.path || agy.command})`);
  } else {
    console.log(`🤖 Engine:     \x1b[31m✗ agy not found in PATH\x1b[0m (Make sure Antigravity is installed)`);
  }

  if (options.showQr) {
    console.log('\n📱 \x1b[1mکد QR زیر را با دوربین گوشی موبایل اسکن کنید:\x1b[0m\n');
    try {
      const qrStr = await QRCode.toString(url, { type: 'terminal', small: true });
      console.log(qrStr);
    } catch {
      console.log(`[QR Error] لطفا آدرس زیر را در مرورگر گوشی باز کنید:\n${url}`);
    }
  }

  console.log('\x1b[90m--------------------------------------------------------------\x1b[0m');
  console.log('\x1b[1m[کلیدهای تعاملی]\x1b[0m [r] QR  [o] مرورگر  [c] پاکسازی  [s] وضعیت  [q] خروج');
  console.log('\x1b[90m--------------------------------------------------------------\x1b[0m\n');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const options = parseArgs(rawArgs);

  if (options.version) {
    console.log('antigravity-mobile-remote v1.0.0');
    process.exit(0);
  }

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Ensure workspace directory exists
  if (!fs.existsSync(options.workspace)) {
    console.error(`\x1b[31m[Error] Workspace directory does not exist: ${options.workspace}\x1b[0m`);
    process.exit(1);
  }

  const webDir = path.join(__dirname, 'web');

  const server = new RemoteServer({
    port: options.port,
    webDir,
    defaultEffort: options.effort,
    workspaceRoot: options.workspace,
    dangerouslySkipPermissions: true,
    onActivity: (event) => {
      const time = new Date().toLocaleTimeString();
      switch (event.type) {
        case 'client_connect':
          console.log(`\x1b[90m[${time}]\x1b[0m \x1b[32m📱 گوشی متصل شد\x1b[0m (${event.ip}) - کلاینت‌های آنلاین: ${event.clientCount}`);
          break;
        case 'client_disconnect':
          console.log(`\x1b[90m[${time}]\x1b[0m \x1b[33m📴 گوشی قطع شد\x1b[0m - کلاینت‌های آنلاین: ${event.clientCount}`);
          break;
        case 'prompt_received':
          const preview = event.text.length > 60 ? event.text.substring(0, 60) + '...' : event.text;
          console.log(`\x1b[90m[${time}]\x1b[0m \x1b[36m💬 پرامپت جدید:\x1b[0m "${preview}" (Effort: ${event.effort})`);
          break;
        case 'tool_update':
          const stateColor = event.state === 'ACTIVE' ? '\x1b[33m' : event.state === 'DONE' ? '\x1b[32m' : '\x1b[31m';
          console.log(`\x1b[90m[${time}]\x1b[0m 🛠️  ابزار: \x1b[1m${event.toolName}\x1b[0m -> ${stateColor}${event.state}\x1b[0m`);
          break;
        case 'turn_finished':
          const durationStr = event.duration ? ` در ${event.duration.toFixed(1)} ثانیه` : '';
          console.log(`\x1b[90m[${time}]\x1b[0m \x1b[32m✓ اجرای ایجنت پایان یافت${durationStr}.\x1b[0m`);
          break;
        case 'turn_error':
          console.log(`\x1b[90m[${time}]\x1b[0m \x1b[31m✗ خطای اجرای ایجنت: ${event.error}\x1b[0m`);
          break;
        case 'turn_cancelled':
          console.log(`\x1b[90m[${time}]\x1b[0m \x1b[33m⚠ اجرای ایجنت توسط کاربر متوقف شد.\x1b[0m`);
          break;
      }
    },
  });

  try {
    const url = await server.start();
    await printBanner(server, {
      showQr: options.showQr,
      effort: options.effort,
      workspace: options.workspace,
    });

    if (options.openBrowser) {
      console.log('🌐 باز کردن در مرورگر دسکتاپ...');
      await openInDefaultBrowser(url);
    }

    // Setup interactive keyboard listening if running in a TTY
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      try {
        process.stdin.setRawMode(true);
      } catch {
        // Ignore if raw mode not supported
      }

      process.stdin.on('keypress', async (str, key) => {
        if (key.ctrl && key.name === 'c') {
          await shutdown();
          return;
        }

        const char = (key.name || str || '').toLowerCase();
        switch (char) {
          case 'q':
            await shutdown();
            break;
          case 'r':
            await printBanner(server, {
              showQr: true,
              effort: options.effort,
              workspace: options.workspace,
            });
            break;
          case 'o':
            console.log(`\n🌐 باز کردن ${url} در مرورگر...`);
            await openInDefaultBrowser(url);
            break;
          case 'c':
            server.clearHistory();
            console.log('\n🧹 تاریخچه گفتگوها پاک شد.');
            break;
          case 's':
            console.log(`\n📊 وضعیت: آنلاین | آدرس: ${url} | مسیر کاری: ${server.getWorkspaceRootPath()} | تاریخچه: ${server.getConversationHistory().length} پیام`);
            break;
          case 'w':
            console.log(`\n📂 دایرکتوری کاری فعال: ${server.getWorkspaceRootPath()}`);
            break;
          case 'h':
          case '?':
            showHelp();
            break;
        }
      });
    }

    async function shutdown() {
      console.log('\n\x1b[33mخاموش‌سازی سرور و پروسه‌ها...\x1b[0m');
      try {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
      } catch {
        // Ignore
      }
      await server.stop();
      console.log('\x1b[32mسرور با موفقیت خاموش شد. بدرود!\x1b[0m');
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n\x1b[31m[Error] پورت ${options.port} در حال حاضر توسط پروسه دیگری استفاده می‌شود.\x1b[0m`);
      console.error(`\x1b[33mراهکار: می‌توانید با سوییچ -p پورت متفاوتی تعیین کنید:\x1b[0m`);
      console.error(`  \x1b[36mantigravity-remote -p ${options.port + 1}\x1b[0m\n`);
    } else {
      console.error('\x1b[31m[Fatal Error] سرور اجرا نشد:\x1b[0m', err.message || err);
    }
    process.exit(1);
  }
}

main();
