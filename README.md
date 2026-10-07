# M33YdESK (personal use)

## What was actually tested (and what wasn't)
Done inside the build sandbox, for real, not simulated:
- ✅ App UI launched under a virtual display (Xvfb) — both Host and Viewer
  screens render correctly with no JS errors (screenshots were shared in chat).
- ✅ Screen-source listing (`desktopCapturer`) returns real sources.
- ✅ Signaling server's pairing + password logic verified with an automated
  script (`signaling-server/test-pairing.js`): wrong password → rejected,
  correct password → both sides get `peer-joined`.
- ✅ A Windows `.exe` (portable build) was produced and confirmed to contain
  the correct **win32** native input-control binary (not Linux's).

**Not possible to test here, be aware:**
- An actual live remote-control session between two real computers — that
  needs two real machines, a real network path to a deployed signaling
  server, and a real second screen, none of which exist in this sandbox.
- The installer `.exe` (NSIS) couldn't be produced — building it needs
  **Wine** on Linux, which isn't available here. What you got instead is
  the **portable build**: unzip `M33YdESK-windows-portable` and run
  `M33YdESK.exe` directly, no installation needed. (Run `npm run build` on
  your own Windows machine later if you ever want a proper signed installer.)
- The exe is **unsigned** (no code-signing certificate). Windows SmartScreen
  will likely show "Windows protected your PC" — click **More info → Run
  anyway**. Some antivirus engines may also flag it, because functionally
  screen-capture + remote-input-injection + networking is exactly the shape
  of both legitimate remote-desktop tools *and* malware — this is a known
  false-positive pattern for any homemade AnyDesk-style tool, not a sign
  something's wrong. If that bothers you, get a code-signing certificate
  and run `npm run build` yourself.


A minimal AnyDesk-style remote desktop tool: screen share + remote mouse/keyboard
control between two of your own computers, over the internet. Built with
Electron + WebRTC. Works Windows ↔ Mac/Linux.

**How it works:** a tiny "signaling server" you run once just helps your two
computers find each other using a 6-digit code (like AnyDesk's ID) and swap
connection info. After that, the actual screen video and control data flow
**directly, peer-to-peer and encrypted (WebRTC/DTLS-SRTP)** — the signaling
server never sees your screen or inputs.

## 1. Deploy the signaling server (do this once)

You need it reachable over the internet (not just localhost), since your two
computers may be on different networks.

```bash
cd signaling-server
npm install
npm start          # runs on port 8080 by default
```

Easiest free options to host it:
- **Render.com** / **Railway.app**: create a new "Web Service" from this
  `signaling-server` folder, it auto-detects Node and runs `npm start`.
  You'll get a URL like `wss://your-app.onrender.com`.
- Or run it on any VPS you own and open the port, or put it behind a
  reverse proxy with TLS (`wss://`).

Note the `wss://...` (or `ws://host:8080` if testing without TLS) URL — you'll
paste it into the app on both computers.

## 2. Install the desktop app on BOTH computers

Requires [Node.js](https://nodejs.org) 18+.

```bash
cd desktop-app
npm install
npm start
```

### macOS-specific setup
System Settings → Privacy & Security → grant the app:
- **Screen Recording** (to share your screen)
- **Accessibility** (to allow remote mouse/keyboard control when this Mac is
  the one being controlled)

### Linux-specific setup
- `nut-js` input injection uses native bindings; on X11 it works out of the
  box. On Wayland, screen capture via Electron's desktopCapturer and global
  input injection are more restricted — X11 (or XWayland) is recommended for
  the host (controlled) machine.

### Windows-specific setup
No extra permissions needed; just allow it through the firewall prompt if
one appears (not required for the P2P connection itself, only matters if you
add a TURN server on your own LAN).

## 3. Connect

- On the computer you want to **control remotely** (the one being watched/driven):
  open the app → paste the signaling server URL → pick the screen to share →
  click **Start Sharing**. It shows a 6-digit code.
- On the computer you're sitting at (the **viewer**): paste the same server
  URL → switch to **Connect** tab → enter that code → **Connect**.

That's it — the viewer sees the host's screen and can move the mouse, click,
scroll, and type.

## Limitations / things to know

- **NAT traversal:** the public STUN server (Google's) handles most home/
  office networks. On very restrictive networks (some corporate/hotel wifi),
  WebRTC may fail to connect directly — you'd then need to add your own
  **TURN server** (e.g. self-hosted [coturn](https://github.com/coturn/coturn))
  and list it in `desktop-app/renderer/renderer.js` under `ICE_SERVERS`.
- **Security:** anyone who knows your 6-digit code during the short window
  it's live could connect. For personal use this mirrors how AnyDesk's
  unattended-access PIN works, but for always-on unattended access you should
  add a fixed password check in the signaling server before pairing, and keep
  the signaling server's URL private.
- **Clipboard sync, file transfer, multi-monitor switching, audio** aren't
  included — this is a focused MVP (screen view + mouse/keyboard control).
  All are addable later via the same data channel.
- **Packaging:** `npm run build` (in `desktop-app`) uses `electron-builder`
  to produce a real installer (.exe / .dmg / .AppImage) for distributing to
  your other machine instead of running `npm start` from source.

## Controlling it from your phone

`mobile-viewer/` is a plain web page (no app install needed) that connects to
the same signaling server and works as a touch-based remote control:

- **1-finger drag** = move the remote cursor (trackpad-style, not direct tap-to-position —
  this matches how most mobile remote-desktop apps work, since phone screens
  are small and finger-precise tapping on exact pixels is unreliable)
- **Tap** = left click, **2-finger tap** = right click, **2-finger drag** = scroll
- **⌨ Keyboard button** = pops up your phone's native keyboard; typed text and
  Backspace are sent to the host in real time
- A row of special keys (Esc, Tab, Ctrl, Alt, arrows, Enter) for shortcuts

To use it:
1. Host this `mobile-viewer` folder somewhere reachable over **HTTPS** (phones
   are strict about this for WebRTC) — e.g. drop it on the same Render/Netlify/
   GitHub Pages account you used for the signaling server, as a static site.
2. On your phone, open that page in Chrome/Safari.
3. Enter the same signaling server URL, the code shown on the host computer,
   and the password — tap Connect.

Tested in this build: the page was rendered in a phone-sized (420×800) window
and loads correctly with no script errors. What wasn't (and couldn't be)
tested here: an actual touch session controlling a real host over a real
network, and iOS Safari's specific WebRTC quirks — try it and tell me if
anything misbehaves so I can adjust it.

## Project structure

```
remote-desktop/
├── signaling-server/   # Node.js WebSocket server (deploy once)
│   ├── server.js
│   ├── test-pairing.js  # self-test: simulates host+viewer pairing & password check
│   └── package.json
├── desktop-app/        # Electron app — the HOST always uses this; can also view from it
│   ├── main.js          # screen sources + OS-level input injection
│   ├── preload.js        # safe bridge to renderer
│   ├── package.json
│   └── renderer/
│       ├── index.html
│       ├── style.css
│       └── renderer.js   # WebRTC + signaling + UI logic
└── mobile-viewer/       # plain web page — open on your phone to view/control, no app needed
    ├── index.html
    ├── style.css
    └── viewer.js
```
