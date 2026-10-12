# Mail Cleaner

Find the senders that flood your mailbox, unsubscribe from them and delete everything they sent. Mail Cleaner works with Outlook (outlook.com, hotmail, live and work or school Microsoft 365 accounts) and Gmail through their own sign-in pages, and with almost any other mail service (Yahoo, iCloud, AOL, GMX, Zoho, internet providers, your own domain) over IMAP.

It is one web app that comes in two editions:

| | Web (GitHub Pages or any static host) | Desktop (Windows, macOS, Linux) |
| --- | --- | --- |
| Outlook and Gmail | Yes, straight from your browser | Yes, the same web app in its own window; you sign in in your browser |
| IMAP | No: browsers can't connect to mail servers | Yes |
| Install | Nothing, open the page | Nothing: download one file and run it |

In both editions the mail never goes through a server of ours: the page talks to Microsoft Graph and the Gmail API directly. The desktop edition shows the same page in the system's own web view (WebView2 on Windows, WebKit on macOS and Linux) through [Photino](https://www.tryphotino.io/), and adds what a browser can't do: IMAP, signing in through your browser, and saving exports.

## What it does

- **Sign in** on Microsoft's or Google's own page (account picker, passkey, Authenticator...). The app never sees your password. Or sign in over IMAP with your address and a password, usually an app password (desktop edition).
- **Storage.** The top card shows how much space your mail uses and what uses it:
  - Outlook: one bar split by your biggest folders (with their subfolders), Deleted Items in red. Microsoft doesn't tell apps the mailbox limit, so the card says what applies and links to Outlook's storage settings.
  - Gmail: used and total from Google, split into Gmail and Google Photos against Google Drive (they share one quota).
  - IMAP: your folders by size, and the total when the server reports a quota.
  - **Empty Deleted Items** or **Empty Trash** deletes everything in it after a confirmation. The card then shows how much you freed since you signed in.
- **Scan.** Inbox and Junk (Spam in Gmail) are ticked by default; tick any other folder or label. For every mail the app keeps sender, subject, date, size, read state and whether it has attachments, in the page's memory only.
  - Outlook: with **Also find unsubscribe links** ticked, the table appears as soon as the mails are read, and the app then reads the `List-Unsubscribe` header of the latest mail of each repeat sender (up to 500 senders) in the background. You can keep working; starting any action stops that lookup.
  - Gmail and IMAP: the unsubscribe headers come with the scan.
- **Pick what to clean.** One table, grouped **by sender** or **by domain**, sortable by mails, size, unread, spam score or date.
  - Quick filters: *Likely spam*, *Can unsubscribe*, *Never opened*, *In Junk*, *With attachments*. Size and age filters: *Older than*, *Senders with at least N mails*, *using more than N MB*, *Mails bigger than N MB*. Search matches the sender, the name or the subject.
  - What you see is what gets removed: with "Older than 1 year" on, removing a sender only removes their mail older than a year.
  - *Likely spam* is a 0 to 100 score from signals the mailbox already has: mail in Junk or Spam, Outlook's "Other" or Gmail's Promotions and Social tabs, mail you never open, no-reply or newsletter addresses, mailing services, unsubscribe headers and volume. Hover a score to see why.
- **View a sender and read a mail.** **View** shows the sender's unsubscribe links, the start of their latest mail and all their mails. Click one to read it: Mark read or unread, Archive, Delete, Newer and Older, and Open in Outlook or Gmail. The mail is shown in a locked-down frame: no scripts, forms or plugins, and no remote images until you click **Show images** (they tell the sender you opened the mail).
- **Clean up.** Select senders, then **Remove**, **Archive**, **Mark read**, **Unsubscribe** or **Add to list**. One dialog for every bulk action, always showing how many mails and how much space:
  - **Remove** to Deleted Items or Trash (default, you can restore them), or delete right away.
  - **Archive** moves the mails to the Archive folder (Outlook, IMAP) or out of the Inbox (Gmail).
  - **Unsubscribe**: senders that support one-click unsubscribe (RFC 8058, which Gmail and Yahoo require from bulk senders) are unsubscribed automatically. For the rest you get a list of links to open. Senders that are mostly junk are skipped: unsubscribing from real spam only confirms your address works.
  - **Block**: Outlook gets one rule, *Mail Cleaner: blocked senders*, that sends their future mail straight to Deleted Items. Gmail gets filters that send it to Trash. IMAP has no standard for server rules, so blocking isn't offered there.
  - Shortcuts: **Remove all** likely spam, **Empty Junk** or **Empty Spam**, and the **Remove list** (addresses or whole `@domains`, saved in your browser for next time).
- **Let an AI choose.** **Export for AI** builds a Markdown summary of your senders for ChatGPT, Copilot, Gemini or any AI chat (copy it, or download it as a `.md` file to attach). **Paste AI answer** reads the addresses and `@domains` from the AI's code block and shows them with checkboxes before anything is added to the remove list. The same window downloads CSV files of your senders or of every mail (the desktop edition saves them in your Downloads folder).

## Use it

**On the web:** open the site (for example `https://<you>.github.io/<repo>/`), pick your mail service and sign in. If the site has default app registrations (see below), that's all. Otherwise the page walks you through registering your own, once.

**Desktop edition** (needed for IMAP): download the file for your system from the [latest release](https://github.com/XxSeRyIxX/mail-cleaner/releases/latest). Nothing else needs to be installed.

- **Windows:** `MailCleaner-windows-x64.exe`. Run it. It uses WebView2, which Windows 10 and 11 already have.
- **macOS:** `MailCleaner-macos-arm64.dmg` (Apple Silicon) or `MailCleaner-macos-x64.dmg` (Intel). Open it and drag Mail Cleaner to Applications.
- **Linux:** `MailCleaner-linux-x64`. Run `chmod +x MailCleaner-linux-x64` once, then start it. It needs WebKitGTK 4.1 (`libwebkit2gtk-4.1-0` on Debian and Ubuntu), which most desktops already have.

The builds aren't signed, so Windows SmartScreen and macOS Gatekeeper warn before the first start. Only go ahead with a download from this repository's releases page. On macOS, after the warning, use System Settings, Privacy & Security, **Open Anyway**.

Signing in to Outlook or Gmail opens Microsoft's or Google's page in your own browser, because both refuse sign-ins inside apps' web views; afterwards the browser tells you to go back to Mail Cleaner. The sign-in lasts until you close the app. Links in mails and unsubscribe pages open in your browser too. Starting the app again while it runs does nothing: there is only ever one window.

From the source code instead: install the [.NET 10 SDK](https://dotnet.microsoft.com/download) (and on Linux `libwebkit2gtk-4.1-dev`) and run `dotnet run --project shell`. Add `-- --dev` to get the web view's developer tools. `dotnet publish shell -c Release -r win-x64` (or `osx-arm64`, `osx-x64`, `linux-x64`) builds the single self-contained file that the releases contain.

## Publish it on GitHub Pages

1. Push this folder to a GitHub repository (the workflows run on the `main` branch).
2. In the repository, **Settings**, **Pages**, **Source**: pick **GitHub Actions**.
3. Push again (or run the workflow from the **Actions** tab). [.github/workflows/pages.yml](.github/workflows/pages.yml) runs the tests, then publishes the `app` folder. The site appears at `https://<you>.github.io/<repo>/`.
4. Optional, so visitors can sign in without registering anything: register the apps below with your site's address, then add them in **Settings**, **Secrets and variables**, **Actions**, **Variables**: `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT` (optional: `common`, `consumers` or `organizations`) and `GOOGLE_CLIENT_ID`. The workflow writes them to `config.json` on every deploy. Read *Default app registrations* first: for Gmail, it is not as simple as for Outlook.

Any other static host works too: serve the `app` folder over HTTPS. The app uses relative paths, so a subfolder is fine.

## Release the desktop edition

[.github/workflows/build.yml](.github/workflows/build.yml) runs the tests and builds the desktop edition for Windows, macOS (Apple Silicon and Intel) and Linux on every push to `main`; the files are under the run's *Artifacts*. Push a tag such as `v1.0.0` and it also publishes a GitHub release with the four downloads, which show that version in About:

```
git tag v1.0.0
git push origin v1.0.0
```

The downloads get default sign-in apps from the Variables `MICROSOFT_CLIENT_ID` and `MICROSOFT_TENANT` (the same Microsoft registration as the website, with the desktop redirect added) and `GOOGLE_DESKTOP_CLIENT_ID`, plus the Secret `GOOGLE_DESKTOP_CLIENT_SECRET`. Leave them out and users register their own, as on the website.

## Register the apps

These are the same for a site owner (default registrations) and for anyone who wants their own. The page shows the exact addresses to use.

### Outlook (about 2 minutes)

1. Sign in to <https://entra.microsoft.com> and open **App registrations**, then **New registration**.
2. Name: `Mail Cleaner`. Supported account types: **Any Entra ID tenant + Personal Microsoft accounts**.
3. Redirect URI: platform **Single-page application (SPA)**, value: the site's address, for example `https://<you>.github.io/<repo>/`. For the desktop edition add the platform **Mobile and desktop applications** with `http://localhost/mail-cleaner` (Authentication, Add a platform). Microsoft ignores the port of localhost addresses, so the app can use any free port. Both platforms can live on one registration.
4. Click **Register** and copy the **Application (client) ID**.

No client secret, no API permissions to add by hand: at first sign-in Microsoft asks you to allow *Read and write access to your mail* and *Read and write your mailbox settings* (the second is only used for the block rule). If your personal account can't open App registrations, create a free Azure account first: it gives you a "Default Directory" where you can register apps.

### Gmail (about 10 minutes)

1. Open <https://console.cloud.google.com/projectcreate> and create a project, for example `Mail Cleaner`.
2. In **APIs & Services**, **Library**, enable the **Gmail API**, and the **Google Drive API** (only used to read how much storage you use).
3. Open **Google Auth Platform**, **Get started**: any app name, your email, audience **External**. In **Audience**, under **Test users**, add the Gmail addresses that may sign in.
4. In **Clients**, **Create client**, application type **Web application**. Under **Authorized JavaScript origins** add the site's origin (`https://<you>.github.io`, without the repository path). No redirect URI and no secret are needed. Copy the **Client ID**.
5. For the desktop edition, create a second client of type **Desktop app** in the same project and copy its **Client ID** and **Client secret**. It needs no redirect URI. Google doesn't treat a desktop app's secret as a secret, since it can't stay hidden in an app people download, but don't put it on the website.

At sign-in Google says it hasn't verified the app: click **Continue** and allow what it asks. The permissions are full access to your mail (needed to delete for good: Empty Trash, delete right away; the app never sends mail), your mail settings (only for the block filters) and the app's own Google Drive data folder, the smallest Drive permission, which lets the app read your storage quota without seeing your files. Google keeps a browser sign-in for one hour; after that the website asks you to click **Continue**, and Google's window usually opens and closes by itself. The desktop edition stays signed in until you close it.

## Default app registrations: is it safe?

Yes, publishing the **client IDs** is safe: they are public identifiers, sent in the address bar of every sign-in anyway, and the website's apps have no secret (single-page apps use PKCE instead). Microsoft and Google only send sign-ins back to the addresses registered for the app, so another site can't use your IDs to get tokens. **Never** put a client secret in the site or in the workflow. The one exception is the Google *Desktop app* client of the desktop edition, whose secret Google itself considers public; keep it in Actions Secrets anyway so it stays out of logs.

What you take on:

- **Your site's code is the security boundary.** Visitors trust the JavaScript you publish with their mail. Protect the GitHub account (two-factor authentication) and the `main` branch: anyone who can push can change what the page does with a signed-in mailbox. The page has a strict Content Security Policy, and only loads scripts from itself and Google's sign-in.
- **Outlook:** the registration works for any Microsoft account. Consent screens show "unverified" until you complete Microsoft's free publisher verification (it needs a Microsoft partner account). Work or school tenants may require an admin to approve the app. Microsoft's throttling limits apply per app and mailbox, so many visitors don't slow each other down. Browser sign-ins last 24 hours, then the page asks again.
- **Gmail:** the mail permissions are *restricted* scopes. While the Google project is in **Testing**, only the test users you add by hand (up to 100) can sign in. Opening it to everyone needs Google's verification, which is free for this app: see *Gmail for everyone* below. Until then, leave `GOOGLE_CLIENT_ID` empty and let each Gmail user register their own client (the page explains how), or add your users as test users.

## Gmail for everyone, for free

Google reviews every app that reads Gmail before strangers can use it. For this app the review costs nothing: the paid yearly security assessment (CASA) is only for apps that store or send Gmail data through their own servers, and Mail Cleaner has none. What Google asks for:

1. **A domain you own.** `github.io` is on the [Public Suffix List](https://publicsuffix.org/), so `<you>.github.io` counts as your own domain. Create the repository `<you>/<you>.github.io` if you don't have it (it serves `https://<you>.github.io/`), then in [Google Search Console](https://search.google.com/search-console) add the URL-prefix property `https://<you>.github.io/` and verify it with the HTML tag or file in that repository, using the Google account that owns the Cloud project. If Google won't accept it, a free developer subdomain on the same list (for example from is-a.dev) pointed at GitHub Pages can be verified with a DNS record instead.
2. **Branding** (Google Auth Platform, Branding): app name, support email, home page `https://<you>.github.io/<repo>/`, privacy policy `https://<you>.github.io/<repo>/privacy.html` (included in the site), authorized domain `<you>.github.io`.
3. **Data access:** declare the three scopes and explain them: full mail access to delete mail for good (Empty Trash, delete right away), the basic settings scope for the block filters, and the app data folder of Drive to show the storage quota. Say that the app runs entirely in the browser and has no server.
4. **A demo video** (unlisted on YouTube, in English): signing in, the consent screen with the client ID in the address bar, then each permission in use: scan, block filter, delete and Empty Trash, storage. If the project has the desktop edition's client too, show its sign-in as well: Google reviews every client of the project.
5. **Publish** the app in Audience and submit it in the Verification Center. Expect a few days to a few weeks and questions by email.

If the review pushes back on full mail access, the app could ask for `gmail.modify` instead and give up deleting for good on Gmail: Gmail empties Trash by itself after 30 days.

## Speed and limits

**Outlook.** Microsoft lets an app make 4 requests at a time and about 10,000 per 10 minutes on a mailbox, and personal outlook.com mailboxes often get less. Scanning reads 500 mails per request. Unsubscribe lookups cost one request per sender and changes one request per mail, sent in batches of 20, so big jobs reach the limit: the app then shows *Microsoft asked this app to slow down, continuing in N s*, waits and slows its own pace. **Empty Deleted Items** also deletes one mail per request, about 1,000 a minute; Outlook's own *Empty folder* is instant.

**Gmail.** Google allows 250 quota units per second per user; reading one mail costs 5. The app stays a bit under that, so a scan reads about 40 mails a second (10,000 mails in about 4 minutes). Cleanups and Empty Trash handle 1,000 mails per request.

**IMAP.** One connection, 500 mails per request, so scans usually take seconds to a minute or two. Moves, flags and deletes go 500 at a time, and Empty Trash is two commands whatever its size.

You can press **Stop** at any time.

## Privacy and safety

- Your mail goes straight between your browser (or the desktop app) and Microsoft, Google or (desktop) your IMAP server. On the website, sign-in tokens stay in the browser tab (session storage) and are gone when you close it; **Sign out** forgets them, and for Google also revokes the app's access. Settings and the remove list are kept in your browser's local storage.
- One-click unsubscribe sends one `POST` from your browser to the address the sender put in their mail, without cookies or referrer, only to `https` addresses on the standard port, and never to an IP address or a local network name.
- Mail bodies are shown in a sandboxed frame with their own strict Content Security Policy: no scripts, no forms, no remote images or fonts until you click **Show images**. In the desktop edition the frame runs one fixed script, allowed by its hash, that hands clicked links to your browser.
- The page refuses to run inside another site's frame, so it can't be overlaid to trick you into clicking Remove.
- Nothing is removed without a confirmation that shows how many mails and from whom. Shared providers such as gmail.com get an extra warning when you target the whole domain.
- Desktop edition: the page and the app talk through the window's own messages, which no website or other program can reach. On Windows the page is served from memory; on macOS and Linux a loopback server serves only the page's files, and only to `127.0.0.1` and `localhost`. Sign-ins use your browser and a one-off loopback port with PKCE (RFC 8252); the refresh token stays in the app's memory. Only `https`, `http` and `mailto` links are handed to your system. The IMAP password is kept encrypted with Windows DPAPI (`%LOCALAPPDATA%\MailCleaner\imap_login.bin`), and only in memory on macOS and Linux. It only goes to your mail server, over TLS (port 993 with SSL/TLS, or STARTTLS). Sign out deletes the password and keeps the server details. Finding the server for a domain the app doesn't know asks `autoconfig.thunderbird.net` about that domain.

## Other services (IMAP, desktop edition)

Pick **Other (IMAP)** and type your email address: the app fills in the server for well-known services, then asks Thunderbird's public database (only the domain is sent), and otherwise guesses `imap.<your domain>`. Type your password and click **Connect**: the app signs in once to check everything before saving it.

- **App passwords.** Yahoo, iCloud, AOL, Fastmail, Zoho (with two-step sign-in) and many others only let other apps in with an app password, created in your account's security settings. GMX and WEB.DE need IMAP turned on in their settings first.
- **Gmail and Microsoft addresses** are pointed to the Gmail and Outlook options, which don't need your password.
- **Proton Mail** works through Proton Mail Bridge (127.0.0.1, port 1143, STARTTLS) with the user name and password the Bridge shows.
- Reading never marks mail as read. Special folders (Junk, Trash, Archive, Sent) are found from the flags servers set (SPECIAL-USE), or by their usual names in English and Spanish. Blocking senders, the Outlook and Gmail tab signals in the spam score, and the start of each sender's latest mail aren't available over IMAP.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Your app registration doesn't treat this page as a single-page app" (AADSTS9002326) | In the app registration, Authentication: add the platform **Single-page application** with the page's address, and remove that address from *Web* or *Mobile and desktop applications*. |
| Desktop: "Your app registration doesn't treat Mail Cleaner as a desktop app" | Add the platform **Mobile and desktop applications** with `http://localhost/mail-cleaner`, and make sure that address isn't also under *Web* or *Single-page application*. |
| Microsoft shows AADSTS50011 (redirect URI mismatch) | Website: add the exact address the setup shows (with the trailing `/`) as a Single-page application redirect URI. Desktop: add `http://localhost/mail-cleaner` under Mobile and desktop applications. |
| Microsoft says the app is only for personal accounts, or only for work accounts | Use your own registration with the matching *Accounts that will sign in*, or fix the registration's supported account types. |
| AADSTS700016 (application not found) | The client ID is wrong, or the app only accepts its own organization. |
| Asked to sign in to Microsoft again after a day | Browser sign-ins last 24 hours. Sign in again. |
| Desktop: the browser never comes back to the app | Finish the sign-in in the browser tab that opened, or press **Cancel** in the app and sign in again. Security software that blocks connections to `localhost` can stop the browser from reaching the app. |
| Desktop: "Google doesn't accept that client ID and secret" | Use a **Desktop app** client and copy both its client ID and its secret. |
| Google shows `origin_mismatch` or "Not a valid origin for the client" | Add the page's origin (scheme, host and port, no path) under *Authorized JavaScript origins* of a **Web application** client. |
| Google shows "Access blocked" or error 403 `access_denied` | Your address isn't a test user of the Google project. Add it under Audience, *Test users*. |
| "Your browser blocked Google's sign-in window" | Allow pop-ups for the page and click again. |
| "Google asked which permissions to allow and not all were ticked" | Sign in again and tick every box. |
| "Gmail API has not been used in project..." | Enable the Gmail API in the project and wait a minute. |
| Storage card: "the Google Drive API is off" | Enable the Google Drive API in the project, wait a minute and reload. |
| "Microsoft asked this app to slow down" | Normal for big jobs. The app waits and continues. |
| IMAP: "refused that user name and password" | Use an app password if your service has them, check the user name and make sure IMAP is turned on in your mail settings. |
| IMAP: "Couldn't reach an IMAP server" or "Couldn't open a secure connection" | Check the server name in your provider's help pages. Use port 993 with SSL/TLS, or 143 with STARTTLS. |

## Upgrading from the earlier desktop versions

The desktop edition now has its own window and signs in through your browser, so the registrations need one change each:

- **Outlook:** in your app registration, Authentication, add the platform **Mobile and desktop applications** with `http://localhost/mail-cleaner`. The old single-page address `http://localhost:5180/` is no longer used: remove it.
- **Gmail:** create a **Desktop app** client (see above) and paste its client ID and secret in the setup. The website keeps using the Web application client.

The saved IMAP login (`imap_login.bin`) is kept. The old token caches (`msal_cache.bin`, `google_token.bin`) and `settings.json` in `%LOCALAPPDATA%\MailCleaner` are no longer used and can be deleted. The remove list and preferences of the old browser-based version stay in that browser; the desktop window starts with its own.

## Project layout

| Path | What it is |
| --- | --- |
| `app/` | The web app. GitHub Pages publishes it as it is; the desktop edition carries it inside the executable |
| `app/index.html`, `app.css` | The page and its Content Security Policy |
| `app/app.js` | The interface: connect, scan, filters, grouping, viewer, cleanup dialogs, AI export and import, and the desktop edition's links and exports |
| `app/about.js` | The About dialog: credits, license notice, links and the version |
| `app/privacy.html` | The privacy policy, which the app also shows in a dialog |
| `app/mail.js` | What every service shares: jobs, pacing and retries, header parsing, one-click unsubscribe, the mail viewer page, the scanned mailbox and the cleanup steps |
| `app/auth.js` | Sign-in: Microsoft (authorization code with PKCE, as a single-page app) and Google (Google Identity Services) on the website, both through the shell on the desktop |
| `app/outlook.js` | Outlook through Microsoft Graph: folders, scan, unsubscribe lookup, actions in JSON batches, block rule, bodies, storage, Empty Deleted Items |
| `app/gmail.js` | Gmail through the Gmail API: labels, scan, actions, block filters, bodies, storage, Empty Trash |
| `app/imap.js` | IMAP through the desktop edition's shell |
| `app/native.js` | The desktop edition's messages to its shell: request ids, replies and cancelling |
| `app/config.json` | Default app registrations (empty in the repository; the workflows fill it in) |
| `shell/Program.cs` | Desktop edition: the Photino window, the page's files and the messages |
| `shell/Commands.cs`, `Messages.cs`, `Errors.cs` | The commands the page can send, their JSON types and their errors |
| `shell/SignIn.cs` | Signing in to Microsoft and Google in the user's browser, with a loopback redirect and PKCE |
| `shell/SiteServer.cs`, `LoopbackHttp.cs` | The page's files, and the small loopback server for macOS and Linux |
| `shell/Desktop.cs` | Opening links in the user's browser and saving exports to Downloads |
| `shell/ImapBridge.cs`, `ImapConnection.cs` | IMAP through MailKit, in small steps the page drives: folders, scan, actions, bodies, quota, Empty Trash |
| `shell/ImapStore.cs` | The IMAP login, checked at setup and kept encrypted with DPAPI on Windows |
| `shell/ImapServers.cs` | Finds the IMAP server for an address: known services, then Thunderbird's database |
| `tests/` | Node tests for the web modules, and `tests/shell`, checks for the desktop services |
| `MailCleaner.slnx` | The desktop edition and its checks, for `dotnet build MailCleaner.slnx` |
| `tools/make-icon.ps1` | Draws `shell/icon.ico` and `app/icon.png` |
| `.github/workflows/` | `checks.yml` (tests on Windows, macOS and Linux), `pages.yml` (the website), `build.yml` (desktop builds and releases) |
| `.github/write-config.ps1` | Fills in `app/config.json` for both workflows: default app registrations, the commit and the version |
| `LICENSE`, `NOTICE` | The GNU AGPL v3, the additional attribution term and third-party notices |

Run the tests with `node --test tests/*.test.mjs` and `dotnet run --project tests/shell`.

## Credits

Made by [XxSeRyIxX](https://github.com/XxSeRyIxX). Built on [MailKit and MimeKit](https://github.com/jstedfast/MailKit) by Jeffrey Stedfast for IMAP, [Photino.NET](https://github.com/tryphotino/photino.NET) for the desktop window, Mozilla's Thunderbird ISP database for finding IMAP servers, and Microsoft Graph, the Gmail API and Google Identity Services. The same list is under About in the app.

## License

[GNU AGPL v3](LICENSE) or later. You are free to use, study, modify and share it. If you distribute a modified version, publish it in an app store, or run one as a network service, you have to publish your source under the same license.

Under section 7(b) of the license, copies and modified versions must keep the "Made by XxSeRyIxX" attribution and the link to this repository in their About dialog. See [NOTICE](NOTICE), which also lists the third-party libraries and their licenses.

Not affiliated with, endorsed by, or connected to Microsoft or Google.
