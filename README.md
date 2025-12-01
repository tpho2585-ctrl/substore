# substore

A simple utility collection for processing node definitions.

## Python: `node_tool.py`

`node_tool.py` 读取一个 JSON 节点列表，检测入口/出口字段、筛选活跃节点并按模板重命名。

快速示例：

```bash
python node_tool.py examples/nodes.json
python node_tool.py examples/nodes.json --latency-threshold 350 -o filtered.json
python node_tool.py examples/nodes.json --pattern "{flag}-{entry}->{exit}-{ip}" --include-inactive
```

占位符：`{name}`、`{flag}`、`{ip}`、`{entry}`、`{exit}`。默认模板：`{flag} {name} {entry}->{exit} ({ip})`

活跃判定：`active/enabled/up` 为真、`status` 为空或 active/up/alive/ok/online，且延迟（如设置阈值）不超过限制。

## JS: `substore_check.js`

参考 [xream/scripts](https://github.com/xream/scripts) 的 availability / http_meta / geo / entrance，以及 [Keywos/rule](https://github.com/Keywos/rule) 的 rename 规则，提供兼容的测活+重命名脚本。

主要功能：

- 并发测活：HTTP/HTTPS，支持超时、重试、代理 (HTTP META) 和离线 `--skip-probe`。
- 状态码判定：数字、范围 (200-299)、比较符 (>=400) 或逗号组合。
- 模板重命名：占位符 `{index,name,flag,ip,entry,exit,country,city,isp,latency}`，可追加延迟 `--show-latency`。
- 兼容筛选：默认跳过未知协议，可用 `--keep-incompatible` 保留。
- 入口/出口/国旗/IP/国家/城市/运营商信息透传，输出汇总。

使用示例：

```bash
# 离线演示
node substore_check.js --input examples/nodes.json --skip-probe

# 自定义测活参数
node substore_check.js --input examples/nodes.json \
  --url "http://connectivitycheck.platform.hicloud.com/generate_204" \
  --status "204,200-299" --timeout 1200 --retries 1 --retry-delay 500 \
  --concurrency 8 --pattern "{flag}{name} {entry}->{exit} ({ip})" --show-latency

# HTTP META 代理模式 (配合 Node.js 版 Sub-Store)
node substore_check.js --input examples/nodes.json --http-meta-protocol http \
  --http-meta-host 127.0.0.1 --http-meta-port 9876 --http-meta-proxy-timeout 8000
```

输出格式：

```json
{
  "summary": {"total": 3, "active": 3, "filtered": 3, "url": "...", "status": "..."},
  "nodes": [
    {
      "index": 1,
      "name": "…原始名称…",
      "flag": "🇭🇰",
      "ip": "203.0.113.10",
      "entry": "HK",
      "exit": "US",
      "country": "Hong Kong",
      "city": "Hong Kong",
      "protocol": "vmess",
      "active": true,
      "status": 204,
      "latency": 123.4,
      "renamed": "🇭🇰HK Edge HK->US (203.0.113.10) (123ms)"
    }
  ]
}
```

示例数据见 `examples/nodes.json`。
