# Cloudflare Tunnel Setup for dev-erp.atithi-setu.com

## Quick Setup (5 minutes)

### Step 1: Login to Cloudflare
```bash
cloudflared tunnel login
```

This will open a browser window asking you to:
1. Select your domain (atithi-setu.com)
2. Authorize Cloudflare to create a tunnel
3. You'll get a certificate file

### Step 2: Create Tunnel
```bash
cloudflared tunnel create atithi-setu-dev
```

This creates a tunnel named "atithi-setu-dev" and gives you a Tunnel ID.

### Step 3: Create Configuration File
Create file: `cloudflare-tunnel-config.yml`

```yaml
tunnel: atithi-setu-dev
credentials-file: C:\Users\Admin\.cloudflared\<TUNNEL_ID>.json

ingress:
  - hostname: dev-erp.atithi-setu.com
    service: http://localhost:3001
  - service: http_status:404
```

Replace `<TUNNEL_ID>` with the ID from Step 2.

### Step 4: Update Cloudflare DNS
1. Go to Cloudflare Dashboard
2. Select atithi-setu.com domain
3. Go to DNS settings
4. Find or create record for: `dev-erp`
5. Change to CNAME record pointing to:
   ```
   <TUNNEL_ID>.cfargotunnel.com
   ```

### Step 5: Run Tunnel
```bash
cloudflared tunnel run atithi-setu-dev --config cloudflare-tunnel-config.yml
```

Keep this running in a terminal window.

---

## Test It

Visit: `https://dev-erp.atithi-setu.com`

You should see the Atithi-Setu login page!

---

## Troubleshooting

**Q: "Error: tunnel doesn't exist"**
A: Make sure you created the tunnel in Step 2

**Q: "Bad gateway 502"**
A: Check that localhost:3001 is running: `curl http://localhost:3001`

**Q: "Connection refused"**
A: The tunnel isn't connected. Run Step 5 and keep the terminal open.

---

## Make It Persistent (Optional)

To run tunnel automatically on startup:

```bash
cloudflared service install
```

This installs it as a Windows Service that runs automatically.

---

## Important Notes

- Keep the tunnel terminal running while you use the app
- The tunnel is free (Cloudflare Tunnel is always free)
- No credit card needed
- Works only while cloudflared process is running
- For production, consider installing as a service

---

## Verify It's Working

```bash
# Check tunnel status
cloudflared tunnel info atithi-setu-dev

# See active connections
cloudflared tunnel list
```

---

Done! Your app is now accessible via the domain! 🎉
