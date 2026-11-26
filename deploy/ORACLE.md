# Deploy on Oracle Cloud Always Free

## 1. Create the VM
1. Sign up at cloud.oracle.com (card needed for verification; Always Free resources aren't charged).
2. Compute > Instances > Create. Image: **Ubuntu 22.04**. Shape: **VM.Standard.A1.Flex**
   (ARM, 2 OCPU / 12 GB is plenty) or **VM.Standard.E2.1.Micro** if ARM is out of capacity.
   If you see "Out of capacity", retry later or pick another availability domain.
3. Add your SSH public key, create, and note the **public IP**.
4. Networking > your subnet's Security List > add **ingress** rules for TCP **80** and **443**
   (source 0.0.0.0/0) and UDP 443.

## 2. Prepare the VM
```bash
ssh ubuntu@<PUBLIC_IP>
# Oracle's Ubuntu image blocks ports in iptables too:
sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -p udp --dport 443 -j ACCEPT
sudo apt-get update && sudo apt-get install -y iptables-persistent   # answer Yes to save rules
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && exit     # log back in so the group applies
```

## 3. Get the code and configure
```bash
ssh ubuntu@<PUBLIC_IP>
git clone <your-repo-url> omc && cd omc
cp .env.production.example .env
nano .env        # set DOMAIN, PUBLIC_URL, ALLOWED_ORIGINS, OIDC_CLIENT_ID/SECRET
```
No domain? Use `<ip-with-dashes>.sslip.io` (e.g. `132-145-1-2.sslip.io`) for DOMAIN; Caddy gets a real certificate for it.

## 4. Google OAuth
Google Cloud Console > APIs & Services > Credentials > your OAuth client:
add `https://<DOMAIN>/auth/callback` to **Authorized redirect URIs**
(and `https://<DOMAIN>` to authorized JavaScript origins if prompted).

## 5. Start
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
curl https://<DOMAIN>/healthz
```

## Operations
- Logs: `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f app1 caddy`
- Update: `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
- Board data lives in the `redis_data` volume (AOF on). Back up with
  `docker compose exec redis redis-cli BGSAVE` and copy the volume.
- Containers use `restart: unless-stopped`, so they come back after a reboot.
