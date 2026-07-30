import {
  LABEL,
  PRIMARY_BTN,
  SIDEBAR_PANEL,
  SIDEBAR_PANEL_HEADER,
  SIDEBAR_TEXTAREA,
} from "./styles";
import { ExampleHint } from './ExampleHint';
import { Tooltip } from './Tooltip';

const GENERATION_EXAMPLE =
  '名为 web 的 Deployment，3 副本，镜像 nginx:1.27，容器端口 80，并通过 ClusterIP Service 暴露 80。';

interface Props {
  requirement: string;
  busy: boolean;
  disabled: boolean;
  loginRequired: boolean;
  actionHint?: string;
  onRequirementChange: (requirement: string) => void;
  onGenerate: (requirement: string) => void;
}

export function GeneratePanel({
  requirement,
  busy,
  disabled,
  loginRequired,
  actionHint,
  onRequirementChange,
  onGenerate,
}: Props) {
  return (
    <div className={SIDEBAR_PANEL}>
      <div className={SIDEBAR_PANEL_HEADER}>
        <span className={LABEL}>生成资源</span>
      </div>
      <div className="px-4 py-3">
        <textarea
          id="generation-requirement"
          aria-label="资源生成需求"
          value={requirement}
          onChange={(e) => onRequirementChange(e.target.value)}
          rows={5}
          placeholder="输入要生成的资源和约束…"
          className={`min-h-[7rem] resize-y ${SIDEBAR_TEXTAREA}`}
        />
        <ExampleHint
          applyLabel="将生成示例填入资源需求"
          onApply={() => onRequirementChange(GENERATION_EXAMPLE)}
        >
          {GENERATION_EXAMPLE}
        </ExampleHint>
        <div className="mt-2">
          <Tooltip content={actionHint} align="start" describeChild>
            <button
              className={PRIMARY_BTN}
              onClick={() => onGenerate(requirement)}
              disabled={disabled || !requirement.trim()}
            >
              {busy
                ? "生成中…(自检)"
                : loginRequired
                  ? "登录后生成到编辑器"
                  : "生成到编辑器"}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
