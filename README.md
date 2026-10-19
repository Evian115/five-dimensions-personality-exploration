# 识己 · 五维人格探索

本地网页当前使用 **识己 IPIP 60 题探索版**：从已校译的 Johnson IPIP-NEO-120 中按内容审阅选取 60 题，每个大维度 12 题、每个细分维度 2 题，共 31 道正向题和 29 道反向题。逐项选题与取舍见 [筛选记录](docs/ipip60-selection.md)。这是尚未独立验证的自定义子集，不是 Maples-Keller IPIP-NEO-60。底层题库与计分来源如下：

- `@bigfive-org/questions@1.3.3`：120 题、原始题目 UUID、正反向标记、所属领域和细分维度。
- `@bigfive-org/score@1.2.2`：五大维度与 30 个细分维度的计分规则。
- `@bigfive-org/results@1.2.9`：结果模板；英文原文保存在 `vendor/bigfive/results/en.json`，中文译写在 `src/interpretations.ts`。

这些包采用 MIT 许可，版权声明和许可证见 `vendor/bigfive/`。本项目最初基于 KatherineGuoGuo/bigfive-open 的 IPIP-50 核心开发；历史结果继续保留原版本，旧题库已从运行代码中移除。

## 运行

需要 Node.js 24 或更高版本，使用内置 SQLite，不需要额外数据库服务。

```bash
npm install
npm run dev
```

首页：`http://127.0.0.1:5173/`。点击“开始认识自己”进入 `/assessment`（旧 `/test` 会自动跳转并保留查询参数）。答题页逐题作答，支持前后切换及随机跳过查看结果；结果页显示五大维度和细分解读。

```bash
npm test
npm run typecheck
npm run build
npm start
```

## Docker 部署

安装并启动 Docker（包含 Docker Compose），在项目目录执行：

```bash
docker compose up -d --build
docker compose ps
```

本机访问 `http://localhost:8080`，同一局域网的其他人访问 `http://部署机器的局域网IP:8080`。需要在部署机器的防火墙中允许 TCP 8080；使用 Docker Desktop 时，填写 Windows 主机的局域网 IP。

如需让互联网上的用户访问，将项目放到有公网 IP 的服务器上运行同一命令，并在云安全组和服务器防火墙开放 TCP 8080，然后访问 `http://公网IP:8080`。家用电脑通常还需要路由器端口转发及可用公网 IP；仅启动 Docker 不会自动获得公网地址。有域名时，可通过反向代理配置 HTTPS 并将请求转发到 8080。

可在项目根目录的 `.env` 中配置宿主机端口和固定分享域名，然后重新执行启动命令：

```dotenv
DOCKER_PORT=8080
BASE_URL=https://你的域名
```

`BASE_URL` 默认留空，分享链接使用访问者当前网页的域名。容器内的监听地址、端口和数据库位置由 Compose 固定配置，不受本地开发的 `HOST`、`PORT`、`DATABASE_PATH` 影响。

SQLite 数据保存在 Docker 命名卷 `bigfive-data` 中，重建镜像、重启容器或执行 `docker compose down` 后仍保留。**不要执行 `docker compose down -v`，该命令会删除卷中的测试结果。** Docker 不会自动导入项目现有的 `data/bigfive.sqlite`；如需迁移历史结果，应先停止写入，用 SQLite 备份方式生成一致的备份，再导入卷，并确保容器内 `node` 用户可以读写。

```bash
# 查看运行日志
docker compose logs -f web
# 更新代码后重新构建并启动
docker compose up -d --build
# 停止服务，保留数据
docker compose down
```

镜像使用多阶段构建，在构建阶段执行类型检查、测试和前端构建；运行阶段使用普通用户，不携带开发依赖。

### WSL 网络排查

如果 WSL 内可以访问网页，但其他电脑不能访问，可在 **Windows 管理员 PowerShell** 中运行仓库内的脚本，只放行网页端口（自定义端口时修改 `-Port`）：

```powershell
powershell.exe -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-26.04\home\it01\code\bigfive-open\scripts\allow-docker-network.ps1" -Port 8080
```

请按实际 WSL 发行版名称和项目路径调整脚本位置。脚本同时配置 Windows 防火墙和可用的 WSL Hyper-V 防火墙规则，不会关闭防火墙。它适用于 WSL 镜像网络；NAT 网络模式还需要配置 Windows 到 WSL 的端口转发。Windows 主机通过自己的局域网 IP 访问 WSL 可能受回环设置限制，可先使用 `http://localhost:8080`，再从同一局域网另一台设备验证。

如果 Windows 的 localhost 能访问、局域网 IP 不能访问，可为 Windows 和 Docker 使用不同端口，避免镜像网络监听冲突。在项目 `.env` 中配置：

```dotenv
DOCKER_PORT=18080
DOCKER_BIND_ADDRESS=127.0.0.1
```

执行 `docker compose up -d`，然后在 Windows 管理员 PowerShell 中执行以下命令，将 Windows 的 8080 端口转发到 Docker 的 18080 端口：

```powershell
powershell.exe -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-26.04\home\it01\code\bigfive-open\scripts\allow-docker-network.ps1" -ListenAddress 0.0.0.0 -Port 8080 -TargetPort 18080
```

此时对外地址仍为 `http://Windows局域网IP:8080`，Windows 本机也可直接访问 `http://localhost:18080`。转发规则保存在 Windows 系统中；如果修改端口，需要同步更新 `.env` 和转发规则。可用管理员命令 `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8080` 删除该转发规则。

如果拉取 `node` 镜像时连接 Docker Hub 超时，但终端通过代理可以连接，检查 **Docker 后台服务**是否也配置了代理。当前机器的原生 WSL Docker 服务已通过 `/etc/systemd/system/docker.service.d/proxy.conf` 配置 `http://127.0.0.1:7897`，修改后需要 `systemctl daemon-reload` 和 `systemctl restart docker`；该代理地址仅适用于当前机器，其他服务器需使用自己的网络配置。代理程序需运行才能继续拉取镜像，已构建的网页容器运行不依赖该代理。

## 中文题目校译

120 道中文题目已逐题对照上游英文校译，保留原始 UUID、英文、维度、细分维度和正反向标记。例如“借刀杀人”改为“我会为了达到自己的目的而利用他人”，“洁身自好”改为“我喜欢收拾整理”，“做事果断干脆”改为“我会不经思考就行动”。完整英文依据保存在 `vendor/bigfive/questions/en.json`。

这是本项目的中文校译，不宣称已通过中文样本的信效度验证。涉及政治倾向的原题仍按英文保留，没有替换题目内容。

## 计分和结果

- 当前共 60 题，五大领域各 12 题，每个领域有 6 个细分维度，每个细分维度 2 题。60 题编号重新连续排列，原题号和 UUID 可追溯。
- 答案保留原始 1–5 选择值，反向题仅在计分时转换一次：`6 - 答案`。
- 当前领域原始分 12–60，细分维度原始分 2–10。每题仍为 1–5 分，不将单题分数减半。
- 按上游默认规则，对**未取整的题均分**进行分类：小于 3 为 low，等于 3 为 neutral，大于 3 为 high。页面把 neutral 命名为“中等”，内部兼容标记为 medium。
- 页面继续显示 0–100 分：`round((题均分 - 1) / 4 * 100)`。这是量表归一化分数，不是人口百分位。
- 五大领域和 30 个细分维度都根据对应分数生成中文解读。两题的细分结果仅供探索参考，页面注明未完成独立信效度验证。
- 当前版本 `shiji-ipip60-exploratory-zh-v1`。120 题、50 题历史结果按原版本还原，不重新计分；浏览器答题进度按版本隔离。
- 旧 50 题版本仍使用已保存的原始分、0–100 分和区间标签，不按新规则重新计算，也不会从 50 题推断 30 个细分分数。

## 保存与分享

SQLite 文件：`data/bigfive.sqlite`；`results` 表包含：

- `id`：`INTEGER PRIMARY KEY AUTOINCREMENT`，自增数字序号。
- `result_json`：量表版本、五大领域及细分维度的结果，不保存逐题答案或提交编号。
- `result_link`：可直接还原结果的链接；配置 BASE_URL 时保存完整地址，否则保存 `/results/view#…` 相对地址，访问时不查数据库。已有结果自动补齐此字段。
- `created_at`：首次写入时间（UTC）。
- `updated_at`：该记录最后更新时间（UTC）；新增时与 `created_at` 相同。

每次独立提交均新增记录，即使分数完全相同也分别保存，不按结果合并。同一次提交使用相同编号和相同答案重试时，返回最初保存的结果链接，不新增记录或更新时间。旧的结果主键表自动迁移为自增序号，保留原有数据、链接与时间；以前已合并的提交无法恢复。数据库中的序号不放进分享链接，访问链接仍直接解密，不查询数据库。

为识别同一次请求的重试，另设技术回执表 `submission_receipts`，保存请求编号、请求内容的 SHA-256 摘要和对应结果序号；`results` 仍保持上述五个字段。回执与结果在同一事务中写入，支持服务重启后的重试，不保存逐题答案。同一编号搭配不同答案返回 409，独立编号不按分数合并。历史记录没有可补出的提交编号，保留原样。

本地草稿同时保存答案与提交编号，完整的 60 题草稿也会保留；只有提交成功或用户明确开始新测评时才清除。完整草稿刷新后停在最后一题，可直接再次提交。旧的仅含答案格式会自动迁移。详见 [提交可靠性说明](docs/submission-reliability.md)。

结果链接：`/results/view#e1_<密文>`，当前 60 题版的结果字符串固定 62 字符，历史 120 题版仍为 67 字符。后端将量表版本及 30 个细分维度原始分紧凑打包，使用 AES-256-GCM 加密及完整性校验；五大领域分数和中文解读由后端还原。密文不携带时间、逐题答案或个人信息。前端访问时通过 `GET /api/results/decode?token=…` 将密文交给后端，解密结果后展示，不查询或写入数据库。密文放在 URL 的 fragment 内，不随页面 GET 请求发送。

密钥首次启动自动生成，位于数据库同目录的 `*.link-key` 文件，Docker 中持久保存在数据卷。重启及重建容器保持同一密钥。迁移服务时必须同时迁移密钥；密钥丢失后已有加密链接无法解密。密钥不传给前端。

旧明文编码链接通过同一解密接口兼容解析，并自动换成加密短链接；数据库已有结果链接也会自动升级，不改变写入时间和更新时间。

历史数据库首次启动时自动迁移，迁移前在数据库同级 `backups/` 目录生成 `*.before-sequence-id-<时间戳>.sqlite` 恢复备份（包含原有历史字段，不参与运行）。旧编号和结果编码保存在同目录的 `*.legacy-links.json` 兼容映射中，启动时载入内存；旧结果链接由此解析并自动替换为加密链接，不查询数据库。迁移后请保留此兼容映射文件，以便旧链接继续工作。

将 `.env.example` 复制为 `.env` 后配置 `BASE_URL`、`HOST`、`PORT`、`DATABASE_PATH`；留空的 BASE_URL 使用当前网页域名。

- `POST /api/results`：`{ submissionId, assessmentId, answers }`。服务端校验并计分，只写入结果，返回包含结果的链接，不返回时间。
- `GET /api/results/decode?token=…`（也兼容 POST `{ token }`）：后端解密并返回分数和解读，不访问数据库；密文损坏或被修改返回 400。
- `GET /api/results/<旧编号>`：仅用于旧链接兼容，从内存映射解析，不读取数据库。

浏览器的答题进度按量表版本隔离保存，校译后需要重新作答，避免混用旧译文下的答案。已经提交的历史结果和分享链接保持原样。

## 首页资源

首页源码为 `src/index.html`、`src/home.ts`、`src/home.css`，网页使用的三个品牌图标在 `public/assets/home/images/branding/`，设计母版与生成说明在 `docs/branding/`。已移除的轮播、博客资源、旧对比页、资源导入脚本和未使用的字体/样式已归档到 `data/archive/cleanup-archive/`，不再参与运行或构建。用户提供的原始首页源码保留作参考。

## 来源与许可

- <https://github.com/rubynor/bigfive-web>
- <https://github.com/Alheimsins/b5-result-text>
- <https://github.com/KatherineGuoGuo/bigfive-open>
- 具体接入版本、中文译写和 MIT 版权声明见 `vendor/bigfive/README.md` 及对应 LICENSE。

本工具用于自我探索与教育参考，不用于临床诊断。

## 本地数据目录

`data/` 已按用途整理：`backups/` 存备份，`testing/` 存手工测试库，`archive/` 存参考资料及旧资源，`exports/docker/` 存离线镜像包。目录说明与迁移校验清单见本地 `data/README.md`；主数据库及 SQLite 配套文件保持原位置。Docker 服务使用独立命名卷，此目录整理不影响运行服务。

## 目录职责

完整检查结果见 [目录检查记录](docs/directory-audit.md)。其中 `src/assessment/` 是 Vite 的作答页面入口，`tests/` 是自动测试；`dist/` 是可重建的产物，`vendor/` 保留上游依据、测试基准及许可证，均有明确用途。

前端页面入口统一位于 `src/`：首页为 `src/index.html`，作答页为 `src/assessment/index.html`。Vite 以 `src/` 为根目录，将根目录 `public/` 中的静态资源复制到根目录 `dist/`；`dist/` 可以通过 `npm run build` 重新生成，不放进源码目录。对外路由继续使用 `/`、`/assessment` 和 `/results/view`。
