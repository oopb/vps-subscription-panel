# VPS 部署说明

这个版本直接部署在 VPS 上，使用 Node.js + SQLite，不需要 Cloudflare Worker、D1 或 relay。

## 1. 安装系统依赖

Ubuntu/Debian 示例：

```bash
sudo apt update
sudo apt install -y curl git build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 2. 上传或拉取项目

示例路径：

```bash
sudo mkdir -p /opt/vps-subscription-panel
sudo chown -R "$USER":"$USER" /opt/vps-subscription-panel
cd /opt/vps-subscription-panel
git clone 你的仓库地址 .
```

如果仓库根目录就是当前项目，进入 Worker 目录：

```bash
cd /opt/vps-subscription-panel/worker
```

## 3. 安装依赖并构建

```bash
npm ci
npm run build:vps
```

## 4. 首次启动

首次启动时，如果 SQLite 数据库里还没有用户，会用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建管理员。

```bash
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='换成你的强密码' \
HOST=0.0.0.0 \
PORT=3000 \
DB_PATH=./data/panel.sqlite \
npm run start:vps
```

浏览器访问：

```text
http://你的VPS_IP:3000
```

防火墙放行：

```bash
sudo ufw allow 3000/tcp
```

## 5. systemd 常驻

创建服务文件：

```bash
sudo nano /etc/systemd/system/vps-subscription-panel.service
```

内容示例：

```ini
[Unit]
Description=VPS subscription panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/vps-subscription-panel/worker
Environment=ADMIN_USERNAME=admin
Environment=ADMIN_PASSWORD=换成你的强密码
Environment=HOST=0.0.0.0
Environment=PORT=3000
Environment=DB_PATH=/opt/vps-subscription-panel/worker/data/panel.sqlite
ExecStart=/usr/bin/node /opt/vps-subscription-panel/worker/dist-node/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vps-subscription-panel
sudo systemctl status vps-subscription-panel --no-pager
```

查看日志：

```bash
sudo journalctl -u vps-subscription-panel -f
```

## 6. 更新代码

```bash
cd /opt/vps-subscription-panel
git pull
cd worker
npm ci
npm run build:vps
sudo systemctl restart vps-subscription-panel
```

## 7. 配置订阅前缀

管理员登录后，在“订阅前缀”里填写 S-UI 的真实订阅接口前缀。

如果 S-UI 和面板在同一台 VPS 上，优先使用本机地址，例如：

```text
http://127.0.0.1:端口/真实订阅路径
```

如果不在同一台 VPS 上，使用那台 S-UI 可以被当前 VPS 访问到的地址。
