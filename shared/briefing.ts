/**
 * 交给本地 agent 的那段话：写给 agent 看，让它自己装说明书、存 Key、自检。
 * 人只要整段复制过去，不需要懂目录、环境变量和 curl。
 *
 * 放在契约层（shared）是因为它是**给 agent 的接口**：改这里的措辞等于改平台对外的
 * 交接方式，界面只是把它渲染出来。
 */
export function agentBriefing(origin: string, key?: string): string {
  const base = origin.replace(/\/+$/, "");
  const keyLine = key
    ? `我的 Key：${key}（只显示这一次，请你自己存好）`
    : "我的 Key：（这里要放我给你的 simk_ 开头的那串；还没生成就先在页面上生成一把）";
  return [
    "你是我的本地 agent。请接入「CompanionSim」，之后用它做虚拟陪伴与角色扮演的仿真评测。",
    "",
    `平台地址：${base}`,
    keyLine,
    "",
    "请依次做完，然后回报结果：",
    `1. 装说明书：下载 ${base}/api/skills.zip 解压，把里面的 companionsim-ops、companionsim-author`,
    "   两个目录放进你自己的 skills 目录（你应该知道自己的 skills 目录在哪；不确定就问我）。",
    "2. 存钥匙：把上面的 Key 记进你自己的凭据配置，调平台接口时带上它（Authorization: Bearer <Key>）。",
    `3. 自检：GET ${base}/api/auth/me —— 应该返回我的名字、我是不是管理员、我今天的额度。`,
    "4. 回报：接口通不通；读完 companionsim-ops 之后，用三句话说清你能替我做哪些事、哪些不能。",
    "",
    "红线（说明书里也写了，这里先说一遍）：你不能代替我做「纳入回归 / 驳回 / 无法判定」这类判定；",
    "不能改被测、评审、仿真 agent 的配置；你做的每一步都记在我名下，所以别用别人的 Key。",
  ].join("\n");
}
