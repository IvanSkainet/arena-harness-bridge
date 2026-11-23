# Install Arena Harness Bridge on Windows

[Инструкция на русском](INSTALL.md)

You’ll need **DeepSeek Harness Desktop 0.2.2-rc.5**, Google Chrome, and Python. Windows checks used Python 3.14. The v0.1.1 ZIP contains Desktop plugin 0.1.11 with its Python companion and Chrome extension 0.1.38. [DeepSeek Harness Desktop](https://deepseek.com/harness/) · [v0.1.1 release](https://github.com/StanislavSmetaninSSM/arena-harness-bridge/releases/tag/v0.1.1)

## 1. Download and extract the ZIP

1. Under **Assets** on the release page, download `arena-harness-bridge-v0.1.1-windows.zip`. Extract it to a folder you plan to keep, such as `C:\Tools\Arena Bridge`. Desktop stores the path to the plugin archive, and Chrome loads the extension from the extracted folder.
2. Install Python and run `python --version` in PowerShell to check that it is on your PATH. The plugin installer also needs access to the npm registry to install dependencies.

## 2. Install the Desktop plugin

1. Start DeepSeek Harness Desktop once so it creates its profile. On the welcome screen, you can choose **Add API key → Set up later**. Then quit Desktop completely from its application menu or system tray icon.
2. Open PowerShell in the extracted folder. If the `dsh` command on your PATH belongs to your Desktop installation, run these commands.

   ```powershell
   $package = (Resolve-Path -LiteralPath '.\dsh-arena-desktop-0.1.11.tgz').Path
   dsh plugin --profile desktop add $package
   ```

   If `dsh` is unavailable or belongs to a different installation, replace the example path with the actual path to `DeepSeek Harness.exe` and run its bundled CLI.

   ```powershell
   $desktop = 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
   $dsh = Join-Path (Split-Path -Parent $desktop) 'resources\runtime\cli\bin\dsh.cmd'
   $package = (Resolve-Path -LiteralPath '.\dsh-arena-desktop-0.1.11.tgz').Path
   & $dsh plugin --profile desktop add $package
   ```

3. Restart Desktop. Create or open a session for your workspace and select **Arena Agent Mode** in the model picker.

## 3. Load the extension and pair the chat

1. In Chrome, open `chrome://extensions`. Turn on **Developer mode**, click **Load unpacked**, and select the `browser-extension` folder from the ZIP.
2. Sign in to Arena and open **Agent Mode**. For a new chat, send the first message in Chrome and wait for a reply. Once the URL looks like `https://arena.ai/agent/<id>`, refresh the tab.
3. In your Desktop session, run `/arena-pair` and click **Copy pairing token**.
4. In the Arena tab, open the **Arena Harness Bridge** extension. Select your Arena conversation, paste the token, and click **Bind conversation**. Use the token only for local pairing.

## 4. Send your first message

In Desktop, type “Reply on one line: THE BRIDGE IS WORKING.” The message should appear in the Arena tab, and the reply should appear in Desktop. For file tasks, choose the workspace and permissions in Desktop. Messages you send, selected attachments, and tool results from the session are sent to Arena.

## Upgrade from v0.1.0

1. Download and extract the new ZIP. Quit Desktop completely from its application menu or system tray icon.
2. Open PowerShell in the new folder and install `dsh-arena-desktop-0.1.11.tgz` into the `desktop` profile using step 2 under [Install the Desktop plugin](#2-install-the-desktop-plugin).
3. Start Desktop again. Chrome can keep using extension 0.1.38 from the previous folder. If you move the extension, remove the old copy in Chrome, load `browser-extension` from the new ZIP, and pair the chat again.

## Troubleshooting

- **Arena Agent Mode or `/arena-pair` is missing.** Check that you installed the plugin with the CLI bundled with your Desktop into the `desktop` profile, then restart the app. The installer may warn about the `@deepseek-ai/dsh-llm` peer dependency on the tested version. After installation, Desktop resolves it from its own runtime.
- **The companion does not start.** Check that Python is on your PATH. If needed, set `ARENA_PYTHON` to the full path to `python.exe` in the environment used to launch Desktop. If another bridge instance is using `127.0.0.1:8766`, close that instance.
- **The original Desktop session was deleted, or you need to change the pairing.** Run `/arena-reset` in any Desktop session in the same profile. This clears the pairing and stops pending deliveries. A send already handed to Chrome may finish in the old chat. Run `/arena-pair` in the intended session and bind the Arena tab.
- **Arena asks for verification.** Complete it in the Chrome tab.

To uninstall the plugin, quit Desktop and run `dsh plugin --profile desktop remove dsh-arena-desktop` with the same CLI. Remove the extension from `chrome://extensions`.
