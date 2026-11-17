# Installing DBee 0.1.0 (unsigned, offline)

The installers contain everything they need. They do not download anything while installing and the
app does not reach the internet when it runs. They are **not code-signed** in 0.1, so the operating
system warns the first time. The warnings are expected; verify the checksum first, then follow the
steps for your system.

## 1. Verify the download

`SHA256SUMS` is published next to the installers. Copy it with them to the offline machine.

```sh
# Linux, macOS (macOS: shasum -a 256 -c SHA256SUMS)
sha256sum -c SHA256SUMS --ignore-missing
```

```powershell
# Windows PowerShell: compare with the line for your file in SHA256SUMS
(Get-FileHash .\DBee_0.1.0_x64-setup.exe -Algorithm SHA256).Hash
```

A checksum that does not match means the file was damaged or changed: do not install it.

## 2. Windows 10 / 11 (x64)

Run `DBee_0.1.0_x64-setup.exe`. It installs for the current user (no administrator rights) and
installs the bundled WebView2 runtime when the machine has none.

- **SmartScreen "Windows protected your PC".** Choose **More info**, then **Run anyway**. The
  publisher shows as unknown because the installer is unsigned.
- If a company policy blocks unsigned installers, an administrator has to allow this file (by its
  SHA-256) or wait for the signed release.

## 3. macOS 12 or later

Open `DBee_0.1.0_aarch64.dmg` (Apple silicon) or `DBee_0.1.0_x64.dmg` (Intel) and drag DBee to
Applications. macOS (Gatekeeper) refuses an unsigned app downloaded from elsewhere. Either:

- Open **System Settings > Privacy & Security**, scroll to the message about DBee and choose
  **Open Anyway** (after the first blocked attempt), or
- Remove the quarantine flag in a terminal, then open the app normally:

  ```sh
  xattr -dr com.apple.quarantine /Applications/DBee.app
  ```

## 4. Linux (x64)

Debian and Ubuntu (needs `libwebkit2gtk-4.1-0`, which apt installs from your mirror):

```sh
sudo apt install ./DBee_0.1.0_amd64.deb
```

Any distribution (needs WebKitGTK 4.1 and FUSE 2 on the machine):

```sh
chmod +x DBee_0.1.0_amd64.AppImage
./DBee_0.1.0_amd64.AppImage
```

## Where DBee keeps things

Settings, tabs and the audit log live in the per-user workspace directory. Passwords go to the
operating system's keychain; without one, DBee asks for them each session and stores nothing.
Uninstalling removes the program; your workspace directory stays until you delete it.
