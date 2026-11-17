# DBee 0.1.0 on Windows: checklist for the person who tests it

The Windows installer is built and the desktop crate is compiled and tested in CI, but nobody has
yet run the installer on a real machine. Use a Windows 11 machine (and a Windows 10 one if you
have it), offline if you can (unplug the network or disable the adapter after copying the files).

1. Copy `DBee_0.1.0_x64-setup.exe` and `SHA256SUMS` to the machine. In PowerShell,
   `(Get-FileHash .\DBee_0.1.0_x64-setup.exe -Algorithm SHA256).Hash` equals the line in `SHA256SUMS`.
2. Run the installer. SmartScreen shows "Windows protected your PC": **More info > Run anyway**
   (expected, the installer is unsigned). It installs without administrator rights.
3. On a machine without WebView2, the installer installs the bundled runtime without a download
   (check with the network off).
4. Start DBee from the Start menu. The window opens in about a second and shows the connections
   screen; no network prompt from the firewall appears (DBee opens no listener).
5. Settings: **Window material (Mica)** is **off** on a fresh install. On Windows 11 turn it on,
   restart DBee: the title bar and window background show Mica with the Aurora theme. Turn it off,
   restart: the plain gradient is back. On Windows 10 the switch must not break anything.
6. Add a connection to a PostgreSQL you can reach, approve the grant, run `select 1`, export the
   result through the save dialog.
7. Close and reopen: tabs and settings are back.
8. Uninstall from Settings > Apps. The program goes away; your workspace folder stays.

Report what failed (and the Windows build number) in TSK-62 or its follow-up. If Mica looks right,
that is the go-ahead to switch the default on (TSK-54).
