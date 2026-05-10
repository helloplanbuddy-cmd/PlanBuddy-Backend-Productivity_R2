# 🏗️ INFRASTRUCTURE SETUP GUIDE FOR planbuddy.in

This guide provides step-by-step instructions for your team to set up production infrastructure.

---

## 1. DATABASE SETUP (PostgreSQL/Supabase)

### Option A: Supabase (Recommended for startups)
```bash
# 1. Create Supabase Pro project
# 2. Get connection string from Settings > Database
# 3. Update .env:
DATABASE_URL=postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres
```

### Option B: AWS RDS PostgreSQL
```bash
# 1. Create RDS instance (db.t3.medium recommended)
# 2. Configure security group (allow access from your app server)
# 3. Get endpoint and update .env
DATABASE_URL=postgresql://postgres:[password]@[endpoint]:5432/planbuddy
```

### Run Migration 184:
```bash
# Connect to database
psql $DATABASE_URL

# Run migration
\i planbuddy_v9/migrations/184_add_idempotency_key_to_refunds.sql

# Verify
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'refunds' AND column_name = 'idempotency_key';
```

---

## 2. REDIS SETUP

### Option A: AWS ElastiCache (Recommended)
```bash
# 1. Create ElastiCache Redis cluster (cache.t3.micro for start)
# 2. Configure security group
# 3. Update .env:
REDIS_URL=redis://[endpoint]:6379
```

### Option B: Supabase Redis
```bash
# Enable Redis in Supabase project
# Update .env with connection string
```

---

## 3. SSL/TLS CERTIFICATES

### Using Let's Encrypt (Free):
```bash
# On your server (Ubuntu/Debian)
sudo apt update
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d planbuddy.in -d www.planbuddy.in

# Auto-renewal is configured automatically
```

---

## 4. NGINX CONFIGURATION

Create `/etc/nginx/sites-available/planbuddy`:
```nginx
upstream planbuddy_backend {
    server localhost:3000;
    keepalive 32;
}

server {
    listen 80;
    server_name planbuddy.in www.planbuddy.in;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name planbuddy.in www.planbuddy.in;

    ssl_certificate /etc/letsencrypt/live/planbuddy.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/planbuddy.in/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;

    location / {
        proxy_pass http://planbuddy_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }

    location /webhooks/razorpay {
        proxy_pass http://planbuddy_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # Increase body size for webhooks
        client_max_body_size 100k;
    }
}
```

Enable and restart:
```bash
sudo ln -s /etc/nginx/sites-available/planbuddy /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## 5. PM2 STARTUP

```bash
# Install PM2 globally
npm install -g pm2

# Start application
cd /path/to/planbuddy_v9
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup systemd
# Run the command it outputs
```

---

## 6. ENVIRONMENT VARIABLES

Create `.env` on production server:
```env
NODE_ENV=production
PORT=3000

# Database
DATABASE_URL=postgresql://...

# Redis
REDIS_URL=redis://...

# Razorpay
RAZORPAY_KEY_ID=your_key_id
RAZORPAY_KEY_SECRET=your_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# JWT
JWT_SECRET=generate_secure_random_string

# Other
LOG_LEVEL=info
PM2_INSTANCES=2
DB_POOL_MAX=25
```

---

## 7. BACKUP CONFIGURATION

### PostgreSQL Backup Script:
```bash
#!/bin/bash
# /usr/local/bin/backup-db.sh

BACKUP_DIR="/var/backups/planbuddy"
DATE=$(date +%Y%m%d_%H%M%S)
pg_dump $DATABASE_URL > $BACKUP_DIR/db_$DATE.sql

# Keep only last 7 days
find $BACKUP_DIR -name "db_*.sql" -mtime +7 -delete
```

### Cron Job:
```bash
# Run daily at 2 AM
0 2 * * * /usr/local/bin/backup-db.sh
```

---

## 8. MONITORING SETUP

### Install Prometheus Node Exporter:
```bash
# Download and install
wget https://github.com/prometheus/node_exporter/releases/download/v1.6.1/node_exporter-1.6.1.linux-amd64.tar.gz
tar xvfz node_exporter-1.6.1.linux-amd64.tar.gz
sudo mv node_exporter-1.6.1.linux-amd64/node_exporter /usr/local/bin/

# Create systemd service
sudo nano /etc/systemd/system/node_exporter.service

# Start service
sudo systemctl daemon-reload
sudo systemctl start node_exporter
sudo systemctl enable node_exporter
```

---

## CHECKLIST

- [ ] Database provisioned and migration 184 applied
- [ ] Redis cluster configured
- [ ] SSL certificates installed
- [ ] Nginx configured and running
- [ ] PM2 started with ecosystem.config.js
- [ ] Environment variables set
- [ ] Backup script configured
- [ ] Monitoring exporter installed

---

**Estimated Time:** 2-4 hours for experienced DevOps engineer