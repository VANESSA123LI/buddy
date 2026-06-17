# Deploying Buddy to AWS (always-on)

Buddy uses Slack **Socket Mode**, so it dials *out* to Slack over a WebSocket — there is
**no public URL, domain, or open inbound port to configure** (only SSH, port 22). You just
need one small Linux box running `node app.js` 24/7. This guide uses **EC2** (free-tier
eligible) or **Lightsail** (simplest), kept alive with **pm2**.

> Why not Lambda / serverless? Socket Mode needs a long-lived connection; Lambda is
> short-lived request/response. Use a VM (or container service), not Lambda.

---

## 1. Launch a Linux box

**Option A — EC2 (free-tier eligible for 12 months)**
1. AWS Console → **EC2** → **Launch instance**
2. AMI: **Amazon Linux 2023**
3. Type: **t3.micro** (free-tier) — if Buddy ever runs out of memory, bump to t3.small
4. Key pair: **create one**, download the `.pem` (you'll SSH with it)
5. Network: allow **SSH (port 22)** from **My IP**. Nothing else needed.
6. Launch, then copy the instance's **Public IPv4 address**.

**Option B — Lightsail (flat ~$5/mo, simplest)**
1. AWS Console → **Lightsail** → **Create instance**
2. Platform: **Linux/Unix** → Blueprint: **OS Only → Amazon Linux 2023**
3. Plan: the **$5/mo** plan is plenty
4. Create, then copy the instance's **Public IP**. (SSH works from the in-browser terminal too.)

---

## 2. SSH in

```sh
ssh -i /path/to/your-key.pem ec2-user@<PUBLIC_IP>
```
(Lightsail: use the browser "Connect using SSH" button instead, or its downloaded key.)

---

## 3. Install Node 20, git, and pm2

```sh
sudo dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
sudo npm install -g pm2
node -v   # should print v20.x
```

---

## 4. Get Buddy's code

```sh
git clone https://github.com/VANESSA123LI/buddy.git
cd buddy
npm install
```

---

## 5. Create the `.env` with your 3 secrets

The repo does **not** include `.env` (it's gitignored), so create it on the server:

```sh
cat > .env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
EOF
chmod 600 .env
```

Where each value comes from (https://api.slack.com/apps → your Buddy app):
- **SLACK_BOT_TOKEN** (`xoxb-…`) — *OAuth & Permissions* → *Bot User OAuth Token*
- **SLACK_APP_TOKEN** (`xapp-…`) — *Basic Information* → *App-Level Tokens* → **Generate**, give it the
  `connections:write` scope (required for Socket Mode)
- **ANTHROPIC_API_KEY** — the same key already working locally

---

## 6. Start Buddy and keep it alive across reboots

```sh
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup      # prints a command — copy/paste & run it to enable boot-start
```

Confirm it's up:
```sh
pm2 logs buddy   # look for "Starter Agent is running!"
```

---

## 7. Turn off the local copy

Once hosted Buddy replies in Slack, **stop `slack run` on your laptop** (Ctrl+C). Otherwise
two Buddies are connected and users get **double replies**.

---

## Day-to-day ops

| Task | Command |
|------|---------|
| View logs | `pm2 logs buddy` |
| Restart | `pm2 restart buddy` |
| Stop | `pm2 stop buddy` |
| Status | `pm2 status` |
| Deploy an update | `git pull && npm install && pm2 restart buddy` |

That last one is your update loop: push a change from your laptop → `git pull` + `pm2 restart`
on the server.
