# Enable HTTPS on Tower 3 Icecast Server

**Step-by-Step Instructions for Configuration**

---

## Prerequisites

- SSH access to the Tower 3 Pi server (romeblue7.myvnc.com)
- sudo privileges
- Domain control over romeblue7.myvnc.com (for Let's Encrypt verification)
- Ports 80 and 443 publicly accessible or ability to use DNS verification

---

## Step 1: Install Certbot and Dependencies

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx curl openssl
```

**Why:** Certbot is the tool to obtain and manage SSL certificates from Let's Encrypt.

---

## Step 2: Obtain an SSL Certificate for romeblue7.myvnc.com

```bash
sudo certbot certonly --standalone -d romeblue7.myvnc.com
```

**Notes:**
- Choose **Option 1: Standalone** (requires port 80 to be accessible temporarily)
- Or use `--dns-cloudflare` if you have DNS provider integration set up
- Certificate will be stored in `/etc/letsencrypt/live/romeblue7.myvnc.com/`
- Valid files will be:
  - `privkey.pem` (private key)
  - `cert.pem` (certificate)
  - `chain.pem` (certificate chain)

---

## Step 3: Create a Combined PEM File for Icecast

Icecast requires a single PEM file containing both the certificate and private key:

```bash
sudo bash -c 'cat /etc/letsencrypt/live/romeblue7.myvnc.com/privkey.pem /etc/letsencrypt/live/romeblue7.myvnc.com/cert.pem > /etc/icecast2/icecast-romeblue7.pem'
sudo chmod 600 /etc/icecast2/icecast-romeblue7.pem
sudo chown icecast:icecast /etc/icecast2/icecast-romeblue7.pem
```

**Why:** Icecast needs a combined PEM file with proper permissions and ownership.

---

## Step 4: Configure Icecast for HTTPS

Edit the Icecast configuration file:

```bash
sudo nano /etc/icecast2/icecast.xml
```

**Find and update (or add) the `<listen>` section:**

```xml
<!-- Add HTTPS listener on port 8089 (or keep 8088 if changing protocol) -->
<listen>
    <port>8089</port>
    <ssl>1</ssl>
    <protocol>http</protocol>
</listen>

<!-- Keep HTTP on 8088 for backward compatibility (optional) -->
<listen>
    <port>8088</port>
    <ssl>0</ssl>
    <protocol>http</protocol>
</listen>
```

**Find and update the `<certificate>` section:**

```xml
<certificate>
    <file>/etc/icecast2/icecast-romeblue7.pem</file>
</certificate>
```

**Save the file** (Ctrl+X, Y, Enter in nano)

---

## Step 5: Restart Icecast Service

```bash
sudo systemctl restart icecast2
```

**Verify the restart was successful:**

```bash
sudo systemctl status icecast2 --no-pager
```

Look for `Active: active (running)` in the output.

---

## Step 6: Test HTTPS Connectivity

From your local machine:

```bash
curl -v https://romeblue7.myvnc.com:8089/status-json.xsl
```

**Success criteria:**
- HTTP 200 response
- No SSL/certificate errors
- Valid JSON returned

---

## Step 7: Verify Mountpoints Work Over HTTPS

```bash
curl -I https://romeblue7.myvnc.com:8089/stream
```

**Expected:** HTTP 200 or 404 (404 is OK if no stream is currently connected)

---

## Step 8: Configure Automatic Certificate Renewal

Let's Encrypt certificates expire in 90 days. Set up automatic renewal:

```bash
sudo certbot renew --dry-run
```

This tests the renewal process. If successful, renewal will happen automatically via cron.

**Verify renewal cron is active:**

```bash
sudo systemctl status certbot.timer
```

---

## Step 9: Create a Post-Renewal Hook

Create a script to regenerate the combined PEM after renewal:

```bash
sudo bash -c 'cat > /etc/letsencrypt/renewal-hooks/post/icecast-renew.sh << EOF
#!/bin/bash
cat /etc/letsencrypt/live/romeblue7.myvnc.com/privkey.pem /etc/letsencrypt/live/romeblue7.myvnc.com/cert.pem > /etc/icecast2/icecast-romeblue7.pem
chown icecast:icecast /etc/icecast2/icecast-romeblue7.pem
systemctl restart icecast2
EOF'

sudo chmod +x /etc/letsencrypt/renewal-hooks/post/icecast-renew.sh
```

**Why:** Certbot will automatically regenerate your combined PEM and restart Icecast whenever the certificate renews.

---

## Step 10: Update Dashboard Configuration

Once HTTPS is working, update the dashboard config in `js/config.js`:

```javascript
tower3: {
    id: "tower3",
    name: "Tower 3 - Out of Bounds",
    baseUrl: "https://romeblue7.myvnc.com:8089",  // Changed port and protocol
    mountpoint: "/stream",
    description: "Primary Broadcast Relay",
    flavorText: "Primary production stream for Out of Bounds.",
    includeInCharts: false,
    includeInHistory: false,
    showLiveStatus: true,
    color: "#27ae60"
}
```

---

## Step 11: Firewall Configuration (If Needed)

If you have a firewall, ensure port 8089 is open:

```bash
# For UFW
sudo ufw allow 8089/tcp

# For iptables
sudo iptables -A INPUT -p tcp --dport 8089 -j ACCEPT
sudo iptables-save  # to persist
```

---

## Troubleshooting Reference

| Issue | Solution |
|-------|----------|
| Certificate not found | Check `/etc/letsencrypt/live/romeblue7.myvnc.com/` exists |
| SSL connection timeout | Verify port 8089 is open and not blocked by firewall |
| 400 Bad Request | Check combined PEM file format (privkey first, cert second) |
| Icecast won't start | Check `/var/log/icecast2/error.log` for details |
| Permission denied errors | Ensure icecast:icecast owns the PEM file |

---

## Verification Checklist

- [ ] Certificate obtained and valid
- [ ] Combined PEM file created and permissions set
- [ ] Icecast restarted successfully
- [ ] HTTPS endpoint responds with HTTP 200
- [ ] Mountpoint accessible over HTTPS
- [ ] Renewal hook script in place
- [ ] Firewall rules updated
- [ ] Dashboard config updated and deployed
