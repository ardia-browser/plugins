# Apple Passwords

Fill logins and verification codes from Apple's Passwords app on any site, whether Ardia shows it with Chrome's engine
or with WebKit. Built into Ardia and off until you turn it on in **Settings › Plugins**.

## What it does
- A key in login and verification code fields. Clicking it opens macOS's Passwords panel at the field, and after
  Touch ID the login you pick is typed in. **Edit › AutoFill › Passwords…** does the same.
- When a site shows a two-factor QR code or `otpauth://` link, Ardia offers to set up the code in Passwords.
- Each profile picks its password manager (**Settings › Profiles › Passwords › Password manager**). Turning the
  plugin on moves profiles that never picked one to Apple Passwords. Those profiles stop offering to save passwords
  in Ardia, and turning the plugin off gives Ardia's manager back.

## What it never sees
The plugin is just a manifest: no program, no page, no code in web pages. Ardia draws the key and opens macOS's panel
itself, and macOS fills the field. No password, username or code passes through the plugin.

## Passkeys
Passkeys saved in iCloud Keychain need Apple to grant Ardia its browser passkey entitlement
(`com.apple.developer.web-browser.public-key-credential`), which it hasn't yet. Until then Ardia offers no
iCloud Keychain passkeys, with or without this plugin. Security keys, passkeys on your phone (QR code) and
passkeys saved in Ardia's own profile still work on Chrome-engine pages. The plugin's Settings page shows the
current status, and asks macOS for access once the entitlement is granted.
