import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  ChatCircle,
  Checks,
  ClipboardText,
  Eye,
  FilmScript,
  Path,
  Robot,
  ShieldCheck,
  Stack,
  UserCircle,
} from "@phosphor-icons/react";
import type { Page } from "../App";
import { Badge, Button, PageHeader } from "../ui";
import "./howto.css";

/**
 * 「怎么用」页：不是给人讲机制，而是给人一段可以直接发给本地 agent 的话。
 *
 * 人是提意图、判卷的那一端；具体动作（编排、跑局、读证据）交给 agent。
 * 所以每张卡片只需要三件事：什么时候用、复制哪句话、谁来收尾。
 */

type Who = "agent" | "你" | "管理员";

type Recipe = {
  id: string;
  title: string;
  when: string;
  prompt: string;
  who: Who[];
  detail: ReactNode;
};

const WHO_LABEL: Record<Who, string> = {
  agent: "agent 做",
  你: "你自己点",
  管理员: "要管理员",
};

const RECIPES: Recipe[] = [
  {
    id: "onboard-agent",
    title: "接一个新的被测 agent",
    when: "第一次把一个 agent 接进来打（我们的、竞品的、本地跑的都可以）。",
    prompt:
      "把一个新的被测 agent 接进仿真平台：它叫「<名字>」，对话接口是 <地址或说明>，鉴权用 <怎么给凭据>。\n接完用内置样例跑一局冒烟，确认能收能发，再告诉我怎么用它和已接入的另一个被测做对比。",
    who: ["agent", "管理员"],
    detail: (
      <>
        <p>
          登记要写清角色基线（说话方式、边界、被问身份怎么答）——评审判「出戏」时拿它当基准，
          不是备注。凭据一律用 <code>${"{"}ENV{"}"}</code> 引用，真实值不要写进配置。
        </p>
        <p>
          改动被测 / 评审 / 仿真 agent 的配置只有<strong>管理员</strong>能落地，
          所以这个 agent 要么由管理员带会话执行，要么把登记内容给你，你在「被测」页确认保存。
        </p>
      </>
    ),
  },
  {
    id: "add-person",
    title: "加一类人（人群）",
    when: "想打「换成这类人会怎样」——比如话少、把不开心咽下去的人。",
    prompt:
      "新增一类人：<画像，例如 25 岁男性、程序员、话少、不主动说需求>。\n要能写出「换这类人后哪一拍会不一样」，用现有剧本 <剧本 id> 打 <失败家族>。\n提交前后各说一句你打算怎么证伪：跑了没差异就合并或删。",
    who: ["agent"],
    detail: (
      <>
        <p>
          平台会检查：画像含年龄、<code>expectedDiff</code> 必须点名一个已存在的剧本、
          两类人差异雷同会被拒（应当合并）。提交后产物上会记「谁加的」。
        </p>
      </>
    ),
  },
  {
    id: "add-script",
    title: "加一份剧本（事件序列）",
    when: "想把某件「事」固定下来反复打——比如三件托付、中途沉默、最后离开。",
    prompt:
      "做一份剧本：<想让人经历的事>。要打 <失败家族：短期记忆 / 禁忌话题 / 幻觉 / 过度承诺>。\n动作只用 speak / silence / leave；台词不要写进剧本，写成 intent / tone / constraints。\n做完自查一遍：有没有哪一拍是在「宣告需求」（那是错的写法）。",
    who: ["agent"],
    detail: (
      <>
        <p>
          一等公民是事件不是台词：台词由仿真 agent 现场生成，纳入回归后才冻结成快照。
          写 <code>jump</code>、<code>sad</code> 这类已移除的动作会被校验拒绝。
        </p>
      </>
    ),
  },
  {
    id: "batch-people",
    title: "批量产出一批人群 / 场景",
    when: "要覆盖一整个面，而不是一次一个。",
    prompt:
      "给我 8 个覆盖 <关系状态 × 性格 × 一种说话习惯> 的人群。先定覆盖轴再逐个产，\n每个都要写得出预期差异，写不出的格子不要产出或与相邻格合并。\n产出后跑一遍：跑了没差异的合并或删，并逐个说明打哪类失败、与已有产物差在哪。",
    who: ["agent"],
    detail: (
      <p>
        规范管这个叫「编排」：平台出封闭能力，人群与剧本由 agent 按规范批量产出，
        校验通过才入库。不要按年龄堆数量。
      </p>
    ),
  },
  {
    id: "run-hunt",
    title: "跑一局探索",
    when: "想看这类人遇上这件事会怎样。",
    prompt:
      "用 <人群> × <剧本> 跑一局探索，被测选 <哪个 agent>。\n开跑前先告诉我预估要花多少 token、我今天还剩多少；跑完给我结论和证据，别直接下判断。",
    who: ["agent"],
    detail: (
      <p>
        探索的台词是仿真 agent 现场生成的，所以它是「候选」不是结论。开跑前平台按剧本长度
        预估额度，超了会先拒。同一被测账号若只允许一个可写会话，相关局会排队。
      </p>
    ),
  },
  {
    id: "read-evidence",
    title: "看某一局凭什么这么判",
    when: "看到分数或结论，想确认依据站不站得住。",
    prompt:
      "把 <局 id> 的证据链讲清楚：五个维度（记忆诚实 / 主动与边界 / 关系与人设 / 能力诚实 / 出戏）\n各自引用了哪几轮、哪些项记的是「测不了」以及为什么；仿真 agent 有没有演歪。\n有争议的地方标出来，别替我下结论。",
    who: ["agent"],
    detail: (
      <p>
        每局都留着逐轮对话与时间、被测请求 trace、评审配置与引用、仿真 agent 逐拍表现。
        缺证据的维度记「测不了」，不是通过——这条是硬规矩。
      </p>
    ),
  },
  {
    id: "rejudge",
    title: "重评一局",
    when: "评审挂了、换了个评审模型，或想复核一遍。",
    prompt: "只重试 <局 id> 的评审。刚才那次是 <为什么>；重评结果与原结论的差异也一起给我。",
    who: ["agent"],
    detail: (
      <p>
        对话与原判定都会保留，评审是<strong>追加</strong>一次尝试。可以用不同模型复核（只影响这次尝试，
        不改平台配置）。重评要花额度。
      </p>
    ),
  },
  {
    id: "replay",
    title: "跑回归：老问题回来没有",
    when: "被测换了版本，想确认原来确认过的问题有没有复现。",
    prompt:
      "用冻结用例 <快照 id> 跑一次回归，被测选 <新版本>。跑完和原局逐事件对照，\n只报差异（哪一拍的回应变了、变的性质是什么），别重新评审出一堆新名词。",
    who: ["agent"],
    detail: (
      <p>
        回归沿用冻结原句，不调仿真 agent，所以便宜也干净：变的只有被测。原局与本次对照、
        人的备注都留档。
      </p>
    ),
  },
  {
    id: "decide",
    title: "判定：纳入回归 / 驳回 / 无法判定",
    when: "看完证据，决定这一局算不算真问题。",
    prompt:
      "把 <局 id> 的证据整理成一段话，说明它是不是「这会破信任」，并给出你建议的判定与理由，\n引用具体哪几轮。我来点确认——这一步不由你代替我决定。",
    who: ["agent", "你"],
    detail: (
      <p>
        这是<strong>只有人能做</strong>的一步：agent 拿 Key 调判定接口会被服务端直接拒绝。
        纳入回归会冻结这一局的台词，之后只能走回归；驳回与无法判定都保留记录。
      </p>
    ),
  },
  {
    id: "routine",
    title: "例行查看",
    when: "想知道今天的额度、最近的变动、谁改了什么。",
    prompt: "看一下今天的额度还剩多少、最近有哪些人加了人群或剧本、有没有谁的 Key 快到期了。",
    who: ["agent"],
    detail: (
      <p>
        每一步操作都留痕（登录、Key 生成与吊销、产物提交、开局、判定、重评、配置变更、提额），
        在「管理」页能查；产物上的「提交人」也来自这份记录。
      </p>
    ),
  },
];

function RecipeCard({ recipe }: { recipe: Recipe }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(recipe.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch {
      setCopied(false);
      window.prompt("复制没成功，手动复制这段：", recipe.prompt);
    }
  }
  return (
    <section className="ht-card">
      <h3>{recipe.title}</h3>
      <p className="ht-when">{recipe.when}</p>
      <pre className="ht-prompt">{recipe.prompt}</pre>
      <div className="ht-who">
        {recipe.who.map((who) => (
          <span className={`ht-chip ${who === "你" ? "you" : who === "管理员" ? "admin" : ""}`} key={who}>
            {WHO_LABEL[who]}
          </span>
        ))}
      </div>
      <div className="ht-actions">
        <Button primary onClick={() => void copy()}>
          <ClipboardText size={15} />
          {copied ? "已复制" : "复制这句话"}
        </Button>
        <details className="compact-details ht-detail">
          <summary>会发生什么</summary>
          {recipe.detail}
        </details>
      </div>
    </section>
  );
}

function Arrow() {
  return (
    <span className="fv-arrow" aria-hidden="true">
      <ArrowRight size={22} />
    </span>
  );
}
function Step({
  number,
  icon,
  title,
  children,
  final = false,
}: {
  number: string;
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  final?: boolean;
}) {
  return (
    <div className={`fv-step ${final ? "fv-final" : ""}`}>
      <div className="fv-step-top">
        <span className="fv-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="fv-number">{number}</span>
      </div>
      <strong>{title}</strong>
      <span className="fv-detail">{children}</span>
    </div>
  );
}
function LaneNode({
  title,
  children,
  kind = "",
}: {
  title: string;
  children: ReactNode;
  kind?: string;
}) {
  return (
    <div className={`fv-lane-node ${kind}`}>
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

export default function HowTo({ onGoto }: { onGoto: (page: Page) => void }) {
  return (
    <div className="page">
      <PageHeader
        title="怎么用"
        subtitle="这个平台是给「你的本地 agent」用的：你说想要什么，它去编排、跑局、找证据；你只决定算不算数。"
      />

      <section className="ht-start">
        <div>
          <h2>第一次用，只做两件事</h2>
          <ol className="plain-list">
            <li>
              去<b>我的</b>页生成一把 Key，复制那段「交给本地 agent」的交接语 —— 它会自己装好
              说明书（Skill）、存好钥匙、调通接口。
            </li>
            <li>
              之后就不用再碰技术细节了：回到这页挑一件想做的事，把那段话发给它。
            </li>
          </ol>
        </div>
        <div className="ht-start-actions">
          <Button primary onClick={() => onGoto("account")}>
            去「我的」页拿 Key
          </Button>
          <Button quiet onClick={() => onGoto("explore")}>
            先看看已有记录
          </Button>
        </div>
      </section>

      <div className="ht-wrap">
        <div className="ht-grid">
          {RECIPES.map((recipe) => (
            <RecipeCard recipe={recipe} key={recipe.id} />
          ))}
        </div>
      </div>

      <p className="footnote">
        每张卡里的「复制这句话」是写给 agent 看的，不是命令，你按自己的说法改也行。
        判定那一步永远由你点：agent 拿不到那个权限。
      </p>

      <details className="compact-details ht-mechanism">
        <summary>平台是怎么运转的（想了解机制时再看）</summary>
        <div className="fv-wrap">
          <section className="fv-diagram" aria-labelledby="fv-main-heading">
            <div className="fv-heading">
              <h2 id="fv-main-heading">
                <span className="fv-index">01</span> 一次评测怎样完成
              </h2>
              <span className="fv-legend">对话结束后自动评审，仍属于「运行中」</span>
            </div>
            <div className="fv-track" aria-label="从意图、编排、留档、对话、评审到人工判定">
              <Step number="01" icon={<UserCircle />} title="人提出意图">
                想观察哪类人
                <br />
                经历怎样的事
              </Step>
              <Arrow />
              <Step
                number="02"
                icon={<Path />}
                title={
                  <>
                    Agent 编排
                    <br />
                    平台校验
                  </>
                }
              >
                复用或新增人群、剧本
                <br />
                校验通过才入库
              </Step>
              <Arrow />
              <Step
                number="03"
                icon={<Stack />}
                title={
                  <>
                    启动并留档
                    <br />
                    本次配置
                  </>
                }
              >
                被测 / 评审 / 仿真 agent
                <br />
                三份快照一起冻结
              </Step>
              <Arrow />
              <div className="fv-running">
                <div className="fv-runlabel">运行中</div>
                <div className="fv-runtrack">
                  <Step number="04" icon={<ChatCircle />} title="仿真对话">
                    仿真 agent 按剧本出话
                    <br />
                    逐轮记录时间与回复
                  </Step>
                  <Arrow />
                  <Step number="05" icon={<Checks />} title="自动评审">
                    独立提示词读证据
                    <br />
                    缺证据就记「测不了」
                  </Step>
                </div>
              </div>
              <Arrow />
              <Step number="06" icon={<Eye />} title="人判定" final>
                纳入回归 / 驳回 /
                <br />
                无法判定
              </Step>
            </div>
            <div className="fv-evidence">
              <span className="fv-evidence-title">本局证据</span>
              <div className="fv-tags">
                {[
                  "发起人",
                  "人群快照",
                  "剧本快照",
                  "被测配置快照",
                  "仿真 agent 配置与提示词哈希",
                  "逐轮时间与对话",
                  "被测请求 trace",
                  "评审配置与五维结果",
                  "本局 token 用量",
                  "判定人与理由引用",
                ].map((label) => (
                  <span className="fv-tag" key={label}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="fv-diagram" aria-labelledby="fv-mode-heading">
            <div className="fv-heading">
              <h2 id="fv-mode-heading">
                <span className="fv-index">02</span> 探索与回归：台词来源和结果去向不同
              </h2>
            </div>
            <div className="fv-lanes">
              <div className="fv-lane">
                <div className="fv-mode">探索</div>
                <LaneNode title="仿真 agent 现场生成台词">人群 × 剧本，LLM 逐拍出话</LaneNode>
                <Arrow />
                <LaneNode title="对话 → 自动评审" kind="fv-lane-live">
                  运行中
                </LaneNode>
                <Arrow />
                <LaneNode title="待审" kind="fv-lane-result">
                  人查看并判定
                </LaneNode>
                <Arrow />
                <LaneNode title="人纳入回归，才冻结台词" kind="fv-lane-freeze">
                  保存来源局与人的理由
                </LaneNode>
              </div>
              <div className="fv-separator" />
              <div className="fv-lane">
                <div className="fv-mode fv-mode-replay">回归</div>
                <LaneNode title="使用已冻结台词">
                  原句、事件与仿真时间一致
                  <br />
                  不再调仿真 agent
                </LaneNode>
                <Arrow />
                <LaneNode title="对话 → 自动评审" kind="fv-lane-live">
                  运行中
                </LaneNode>
                <Arrow />
                <LaneNode title="结果待查看" kind="fv-lane-result">
                  自动评审已完成
                </LaneNode>
                <Arrow />
                <LaneNode title="人查看，与原局对照">保存本次观察与备注</LaneNode>
              </div>
            </div>
            <p className="fv-lane-note">
              回归省掉生成那一段，只付一次评审，所以同样剧本的估算是探索的零头。
              探索里的驳回或无法判定不产生冻结台词；无法判定可以回来补证。
            </p>
            <div className="fv-recovery">
              <strong>评审失败</strong>
              <Arrow />
              <span>保留完整对话与快照</span>
              <Arrow />
              <strong>只重试评审</strong>
              <Arrow />
              <span>追加新尝试，保留人的判定</span>
            </div>
          </section>

          <section className="fv-diagram" aria-labelledby="fv-role-heading">
            <div className="fv-heading">
              <h2 id="fv-role-heading">
                <span className="fv-index">03</span> 谁能做什么
              </h2>
              <span className="fv-legend">服务端逐条接口校验，界面只是提示</span>
            </div>
            <div className="fv-track fv-track-roles">
              <Step number="01" icon={<UserCircle />} title="账号登录">
                用户名和密码
                <br />
                账号由管理员创建
              </Step>
              <Arrow />
              <Step number="02" icon={<Robot />} title="本地 agent 用 Key">
                Codex / pi / Claude Code
                <br />
                人在「我的」页发一把
              </Step>
              <Arrow />
              <Step number="03" icon={<ShieldCheck />} title="管理员" final>
                首个管理员由配置种子写入
                <br />
                其余角色在管理页提升
              </Step>
            </div>
            <div className="table-wrap fv-role-table">
              <table>
                <thead>
                  <tr>
                    <th>身份</th>
                    <th>能做</th>
                    <th>不能做</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <Badge>成员 member</Badge>
                      <small>用户名密码登录</small>
                    </td>
                    <td>看全部记录、发起探索/回归、判定、重试评审、生成自己的 Key</td>
                    <td>改被测 / 评审 / 仿真 agent 的配置</td>
                  </tr>
                  <tr>
                    <td>
                      <Badge tone="blue">管理员</Badge>
                      <small>管理页提升，或启动时的首个管理员</small>
                    </td>
                    <td>上面全部，外加配置三件套、配额提额、用户与角色、看审计</td>
                    <td>—</td>
                  </tr>
                  <tr>
                    <td>
                      <Badge tone="orange">本地 agent（Key）</Badge>
                      <small>人在「我的」页生成</small>
                    </td>
                    <td>读目录与记录、提交人群/剧本、发起探索/回归、重试评审</td>
                    <td>
                      <strong>代签人的判定</strong>、改配置；Key 永远不是管理员
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="fv-lane-note">
              「纳入回归」是人的判断，平台在服务端拒绝 Key 调判定接口——不是靠约定，是拿不到权限。
              Key 的每一步操作都记在它的主人名下。
            </p>
          </section>

          <section className="fv-diagram" aria-labelledby="fv-cost-heading">
            <div className="fv-heading">
              <h2 id="fv-cost-heading">
                <span className="fv-index">04</span> 操作人留痕与 token 额度
              </h2>
              <span className="fv-legend">额度只拦「下一次能不能开」，不掐断正在跑的局</span>
            </div>
            <div className="fv-track">
              <Step number="01" icon={<Stack />} title="开跑前预估">
                按剧本拍数 × 回看轮数
                <br />
                再加一次评审
              </Step>
              <Arrow />
              <Step
                number="02"
                icon={<Checks />}
                title={
                  <>
                    额够就开跑
                    <br />
                    不够直接拒
                  </>
                }
              >
                拒绝时给全三个数
                <br />
                预估 / 今日已用 / 上限
              </Step>
              <Arrow />
              <Step number="03" icon={<FilmScript />} title="跑完按实测记账" final>
                网关报的 usage 优先
                <br />
                没报就按字符估算并标明
              </Step>
            </div>
            <div className="fv-evidence">
              <span className="fv-evidence-title">留痕记什么</span>
              <div className="fv-tags">
                {[
                  "登录与登出",
                  "Key 生成 / 吊销",
                  "人群剧本提交人",
                  "谁发起了哪一局",
                  "谁判定 / 谁重评",
                  "配置变更前后哈希",
                  "按人提额",
                ].map((label) => (
                  <span className="fv-tag" key={label}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <p className="fv-lane-note">
              每局消耗取「预估合计」与「实测合计」中的较大者：同一局不会被算两遍，也不会因为
              实测要等跑完而被低谷低估。额度按天、按人分开，第二天自然归零。
            </p>
          </section>

          <div className="fv-explanation">
            <section>
              <h3>配置可追溯，远端版本如实记录</h3>
              <p>
                每局把被测、评审、仿真 agent 三份调用配置与提示词哈希一起存档；人工登记的版本
                与服务返回的版本分开保留。接口没提供的显示「未知」，旧记录没采集的显示「未记录」。
              </p>
            </section>
            <section>
              <h3>两套时间，各有用途</h3>
              <p>
                仿真时间描述剧情（只作会话内先后标注，不注入被测），真实时间用于对齐请求日志。
                首字与总响应耗时只算被测请求；对话与评审分别计时。
              </p>
            </section>
            <section>
              <h3>现在做不到什么（别当成通过）</h3>
              <p>
                假时钟已从动作表移除，本版只做一次连续时间的对话，跨日记忆那类考点测不深；
                主动收件箱没有适配器；不是每种被测都提供记忆接口，缺记录就记「测不了」。
                台词由仿真 agent 的 LLM 现场生成，与评审刻意不同模型家族、不同提示词。
              </p>
            </section>
            <section>
              <h3>不想装 agent 也能用</h3>
              <p>
                界面里都能点：探索页发起、待审队列判定、回归页重跑、人群与剧本页浏览产物。
                agent 只是替你把这些串起来，以及在你不想手写 JSON 的时候负责编排。
              </p>
            </section>
          </div>
        </div>
      </details>
    </div>
  );
}
