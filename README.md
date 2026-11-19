# Orchestrator

A local web dashboard for starting, stopping, and restarting application commands and following stdout and stderr. Requires Node.js 22 or later. No package install or database setup is needed.

## Run it

1. In this directory, run `npm start` (or `node server.mjs`).
2. On the first start, the manager opens a private local page to pair your browser automatically. If it does not open, use the `file:` link in the terminal within five minutes. After pairing, bookmark [http://127.0.0.1:4321/](http://127.0.0.1:4321/). Nothing needs to be typed or approved for individual apps.
3. Click **Add application** and enter a **Name**, **Command**, **Working directory**, and optionally an **Application URL**. For the included [example server](./apps/example/server.cjs), use `Example`, command `node server.cjs`, and directory `example`. Leave the URL blank because the example picks its own port.
4. Click **Start** immediately after saving. Use **Open application** to open the saved HTTP(S) URL in a new tab; this does not change the app's port or launch another process. Apps without a URL do not show the link. The example prints its address in **Output logs** instead.
5. To change the name, command, working directory, or URL, stop the app, select **Edit**, then **Save changes**. The registration and its logs are kept. Saving does not start the app.
6. **Delete** stops a running app and removes its registration and log buffer, not its source files. Press **Ctrl+C** in the manager terminal to stop all managed apps and the dashboard.

Pairing survives manager restarts in the same browser profile. To switch browsers, recover after clearing browser storage, or replace an expired invitation, stop the manager and run `npm start -- --pair`. Open the new local pairing page in the intended profile; successful pairing replaces the previous session. To revoke access without pairing a replacement, stop the manager and remove `paired-browser.sha256` from its data directory.

## Use your own applications

The working directory can be an existing absolute local path, such as `C:\Projects\services\billing`, or a path relative to the applications root. The default `.` uses the root itself (`apps/` by default). You can change the base for relative paths before starting the manager:

```powershell
$env:ORCHESTRATOR_APPS_ROOT = 'C:\Projects\services'
npm start
```

For example, with the root above, use the name `Billing`, command `npm run dev`, working directory `billing`, and URL `http://localhost:3000` if that is where the service listens. The resolved directory is saved and used for every start and restart; the command does not need `cd`. Existing registrations work without re-adding them. Existing commands without a saved directory use the applications root; legacy entry-file registrations still use their direct Node launcher.

Enter a single **foreground** command line for the system shell (`cmd.exe` on Windows, `/bin/sh` on Unix). Shell quoting and operators are supported.

Commands inherit the manager's permissions and environment. The working directory is not a sandbox. Keep commands, scripts, and registry files writable only by trusted users, and run as a non-administrator. Do not put secrets in command lines; the dashboard displays them.

- **Persistence:** registrations are saved in `.orchestrator/applications.json`. They load as stopped; apps are not automatically restarted. Use one manager per registry. Set `ORCHESTRATOR_DATA_DIR` to use a different registry, for example when switching app roots.
- **Port:** the dashboard always uses `4321`. If the port is occupied, startup fails instead of switching ports. Each managed server is responsible for its own port.
- **Logs:** the latest 250 output records per application are kept in memory, including stderr and lifecycle events. Records are capped at 4,096 characters plus a truncation marker. Logs remain available after stopping an app but not after restarting the manager. The UI refreshes about once a second.
- **Process scope:** for launch commands, Stop targets the shell's process tree on Windows (immediate termination) or its process group on Unix (four-second grace period). Do not use `start`, `nohup`, background (`&`), or daemonizing commands: processes that outlive or detach from their launcher may not be manageable. Legacy entry files still use direct-process termination.
- **Access:** the dashboard listens only on `127.0.0.1`. The process API requires a paired browser and rejects cross-origin requests. Anyone with access to that browser profile can run commands as the manager's OS user. Keep your profile and manager files private, reserve the dashboard origin for this tool, and do not expose it through a proxy or port forward.

## Verify

Run `npm test`. The integration tests use temporary registries and real Node processes on ephemeral loopback ports; they do not touch your registered apps.
