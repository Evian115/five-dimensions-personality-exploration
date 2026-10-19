# 钉钉测评记录同步

## 提交与同步

新的有效提交在同一 SQLite 事务内保存结果、提交回执和 `dingtalk_outbox` 同步任务。提交成功即可正常查看结果，钉钉临时故障不会清除答案或阻止测评结果展示。

- 新任务使用同一次提交的 UUID 作为钉钉 `clientToken`。重复提交不会创建第二条任务；不同提交即使分数相同也分别同步。
- 后端立即尝试处理新任务，失败后按 10、20、40、80、160、300 秒间隔重试。达到 300 秒后保持该间隔，不丢弃未同步的任务。
- 同步任务随数据库持久化，重启后继续。任务使用 60 秒租约和租约标识，多个进程不会正常抢占同一个未到期任务；进程意外退出后可恢复。响应丢失后仍使用同一 `clientToken`，由钉钉幂等接口防止重复新增。
- 同步成功后保存钉钉返回的记录 `id`，之后不再重复发送。
- 真实钉钉接口对相同 `clientToken` 返回 `invalidRequest.duplicateClientToken`。遇到此错误时，先用五个整数分数筛选候选记录，再逐条核对完整加密结果链接、两项时间与五个分数；仅唯一一致时恢复原记录 ID。缺失、内容变化或存在多条匹配时保留任务并报错，不把重复令牌本身当作成功。当前钉钉不支持 URL 字段筛选，因此完整链接在后端核对。不同提交不按分数合并。
- 作答、刷新结果、解密结果和复制分享链接不会创建同步任务。访问结果仍直接解密，不查询 SQLite。
- 同步进度、租约和重试信息仅更新技术队列表，不更新 `results` 的分数、链接或写入/更新时间。`results` 仍只在有效提交时新增。
- 上线前的历史结果不会自动批量写入钉钉。

## 字段对应

| 钉钉字段 | 来源 | 发送格式 |
| --- | --- | --- |
| 写入时间 | `results.created_at` | 毫秒时间戳，日期字段 |
| 开放性 | `results.openness` | 0–100 整数 |
| 尽责性 | `results.conscientiousness` | 0–100 整数 |
| 外向性 | `results.extraversion` | 0–100 整数 |
| 宜人性 | `results.agreeableness` | 0–100 整数 |
| 神经质 | `results.neuroticism` | 0–100 整数 |
| 链接 | 提交成功后生成的完整分享链接 | `{ "text": "查看测评结果", "link": "完整链接" }` |
| 更新时间 | `results.updated_at` | 毫秒时间戳，日期字段 |

`BASE_URL` 配置时使用它生成的分享链接；留空时使用本次网页提交的 Origin（没有 Origin 的 API 请求使用 Host）补全相对链接，和前端复制分享链接的解析方式一致。不要使用请求体中的任意链接替代服务端生成的结果令牌。

## 后端环境变量

实际凭据只写在未纳入 Git 的 `.env` 或生产环境配置中。Docker Compose 将这些变量传入后端；它们没有 `VITE_` 前缀，不进入前端包。

```dotenv
DINGTALK_APP_KEY=
DINGTALK_APP_SECRET=
DINGTALK_BASE_ID=
DINGTALK_SHEET_ID_OR_NAME=
DINGTALK_USER_ID=
DINGTALK_OPERATOR_ID=
```

- `DINGTALK_BASE_ID` 是 AI 表格文档 ID。
- `DINGTALK_SHEET_ID_OR_NAME` 是文档中的数据表 ID 或名称。
- `DINGTALK_USER_ID` 保存实际员工 userId，查询用户详情时读取该环境变量来取得 unionId；不转换为数字，以免长 ID 丢失精度。
- `DINGTALK_OPERATOR_ID` 必须是对该表有编辑权限用户的 **unionId**。
- 应用需要开通 `Notable.Base.Write.All`（AI 表格应用写权限）；重复请求的记录核验需要 `Notable.Base.Read.All`（读权限）。通过 userId 查询 unionId 另需 `qyapi_get_member`（成员信息读权限）。
- 前四项全部留空时，不启用钉钉功能；只填写部分时拒绝启动并提示缺少的变量名。
- 前四项齐全但缺少操作人时，提交仍入队，启动时提示等待 unionId，不发送真实钉钉写入请求。配置好 unionId 并重新创建服务后，积压任务继续同步。

后端通过企业内部应用接口获取 accessToken，缓存并提前刷新；不会把 token 返回浏览器或记录完整上游响应。单次请求限制 10 秒，一次投递的所有调用合计限制 45 秒（短于 60 秒租约）；401 后刷新 token 并使用原 clientToken 再尝试一次。

## 操作人身份

表格链接与 AppKey/AppSecret 不能直接确定操作人。

- 通过免登码获取用户信息，需要钉钉客户端生成的 `code`，有效期五分钟且只能使用一次；响应中的 `result.unionid` 才是操作人 unionId。
- 查询用户详情，需要实际用户的 `userid`；接口返回 `result.unionid`。该调用需要成员信息读权限。

代码中的 `createDingtalkClient().resolveUnionId()` 支持这两种方式；不会拿文档示例用户或随机选择企业成员当作操作人。

## 验证范围

自动测试使用独立临时数据库和模拟钉钉 API，验证：字段格式、token 缓存/刷新、身份解析、超时、远端错误、入队事务回滚、租约恢复、重复请求及响应丢失后的重试。2026-10-19 真实接口复测已通过：通过环境变量中的 userId 获取并保存 unionId，核对八个字段类型；从隔离测试库经实际提交接口向目标表格写入、读回并核对日期、五个整数分数和完整分享链接。原 clientToken 重放恢复同一钉钉记录 ID，8 次 HTTP 重试只保留一条本地记录和一条远端记录；分享链接可由生产服务直接解密。测试结束后删除临时钉钉行与临时测试库，不向正式数据库插入测试记录。

自动测试现为 61 项，包含真实接口差异的回归用例。复测摘要位于 `data/testing/dingtalk-20261019/live-test.json`，不含凭据。

参考官方文档：[数据说明](https://open.dingtalk.com/document/development/data-structure)、[新增记录](https://open.dingtalk.com/document/development/api-notable-insertrecords)、[获取应用 accessToken](https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app)、[通过免登码获取用户信息](https://open.dingtalk.com/document/development/obtain-the-userid-of-a-user-by-using-the-log-free)、[查询用户详情](https://open.dingtalk.com/document/development/query-user-details)。
