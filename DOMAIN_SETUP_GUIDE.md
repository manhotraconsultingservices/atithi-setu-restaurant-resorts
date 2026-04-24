# Setting Up demo-erp.atithi-setu.com

## Current Situation
- ✅ Application running on: **localhost:5001**
- ❌ Domain points to: **185.38.109.x** (external servers)
- ❌ Domain cannot reach your local app

---

## Quick Solutions

### Solution 1: Use ngrok (5 min - Easiest)
```bash
# Download and install from https://ngrok.com

# Run ngrok tunnel
ngrok http 5001

# You'll get a URL like:
# https://xxxx-xxxx-xxxx-xxxx.ngrok.io

# Share this URL instead of the domain
```

**Pros:**
- ✅ Works immediately
- ✅ Publicly accessible
- ✅ No DNS/nginx needed

**Cons:**
- ❌ URL changes on restart
- ❌ Only free for limited time
- ❌ Not for production

---

### Solution 2: Point Domain to Your Server

If you have a VPS/server with a public IP:

1. **Update DNS Records** in your domain registrar:
   ```
   demo-erp.atithi-setu.com  A  <YOUR_PUBLIC_IP>
   ```

2. **Set up nginx reverse proxy:**
   ```bash
   sudo apt-get install nginx
   sudo cp nginx-reverse-proxy.conf /etc/nginx/sites-available/demo-erp.atithi-setu.com
   sudo ln -s /etc/nginx/sites-available/demo-erp.atithi-setu.com /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

3. **Get SSL Certificate (Let's Encrypt):**
   ```bash
   sudo apt-get install certbot python3-certbot-nginx
   sudo certbot --nginx -d demo-erp.atithi-setu.com
   ```

4. **Update nginx config** with SSL certificate paths

---

### Solution 3: Update Docker Compose

Add nginx service to `docker-compose.yml`:

```yaml
nginx:
  image: nginx:alpine
  container_name: demo-erp-nginx
  ports:
    - "80:80"
    - "443:443"
  volumes:
    - ./nginx-reverse-proxy.conf:/etc/nginx/conf.d/default.conf
    # - ./certs:/etc/nginx/certs  # When you have SSL certs
  depends_on:
    - node_app
  networks:
    - dev-erp_default
```

Then restart:
```bash
docker compose up -d nginx
```

---

## Recommended: Use ngrok Now, Plan Later

**For immediate access:**
```bash
# Terminal 1: Keep your app running
docker compose up -d

# Terminal 2: Start ngrok tunnel
ngrok http 5001

# Access at: https://xxxx-xxxx-xxxx-xxxx.ngrok.io
```

**When ready for production:**
1. Get a VPS with public IP
2. Point domain to your VPS IP
3. Run nginx reverse proxy on VPS
4. Add SSL certificate

---

## FAQ

**Q: Why doesn't the domain work?**
A: The domain points to external servers, not your local machine.

**Q: Can I change the DNS?**
A: Yes, if you own the domain registrar account.

**Q: Will localhost:5001 still work?**
A: Yes, always accessible locally.

**Q: What's the best production setup?**
A: Domain → Public IP → nginx reverse proxy → localhost:5001 + SSL

---

## Support

For ngrok help: https://ngrok.com/docs
For nginx help: https://nginx.org/en/docs/
For Let's Encrypt SSL: https://letsencrypt.org/

Your application is ready. Just need to expose it properly! 🚀
