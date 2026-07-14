import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import type { EdgeLabelMode, ViewerGraphConfig } from "./graphConfig";

// The graph controls panel, rebuilt on native range inputs (no antd here) and the
// viewer's sharp-corner design language. Sliders edit the scalar fields live; the
// simulation reheats on every change so the effect is immediate.

function formatValue(value: number, digits = 2) {
  return Number(value.toFixed(digits)).toString();
}

function ControlRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="graphControlRow">
      <div className="graphControlMeta">
        <span className="graphControlLabel">{label}</span>
        <span className="graphControlValue">{formatValue(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function GraphControlsPanel({
  graphConfig,
  onChange,
  onReset,
  onClose,
}: {
  graphConfig: ViewerGraphConfig;
  onChange: (next: ViewerGraphConfig) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [isDisplayOpen, setIsDisplayOpen] = useState(true);
  const [isForcesOpen, setIsForcesOpen] = useState(true);

  const updateDisplay = (
    key: keyof ViewerGraphConfig["display"],
    value: number | EdgeLabelMode | boolean,
  ) => {
    onChange({ ...graphConfig, display: { ...graphConfig.display, [key]: value } });
  };
  const updateForce = (
    key: "centerForce" | "repelForce" | "linkForce" | "linkDistance",
    value: number,
  ) => {
    onChange({ ...graphConfig, forces: { ...graphConfig.forces, [key]: value } });
  };

  return (
    <div className="graphControlsPanel">
      <div className="graphControlsHeader">
        <span className="graphControlsTitle">graph controls</span>
        <div className="graphControlsActions">
          <button type="button" className="metaAction" onClick={onReset}>
            reset
          </button>
          <button
            type="button"
            className="graphIconButton"
            onClick={onClose}
            aria-label="Close graph controls"
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <section className="graphControlSection">
        <button
          type="button"
          className="graphControlSectionButton"
          onClick={() => setIsDisplayOpen((v) => !v)}
        >
          {isDisplayOpen ? (
            <ChevronDown size={13} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} />
          )}
          display
        </button>
        {isDisplayOpen && (
          <div className="graphControlRows">
            <div className="graphControlRow">
              <div className="graphControlMeta">
                <span className="graphControlLabel">show entities</span>
              </div>
              <div className="graphSegment">
                {([false, true] as const).map((on) => (
                  <button
                    key={String(on)}
                    type="button"
                    className={`graphSegmentBtn ${
                      graphConfig.display.showEntities === on ? "graphSegmentBtnActive" : ""
                    }`}
                    onClick={() => updateDisplay("showEntities", on)}
                  >
                    {on ? "yes" : "no"}
                  </button>
                ))}
              </div>
            </div>
            <ControlRow
              label="node size"
              value={graphConfig.display.nodeSizeMultiplier}
              min={0.5}
              max={3}
              step={0.05}
              onChange={(v) => updateDisplay("nodeSizeMultiplier", v)}
            />
            <ControlRow
              label="link thickness"
              value={graphConfig.display.linkThicknessMultiplier}
              min={0.5}
              max={3}
              step={0.05}
              onChange={(v) => updateDisplay("linkThicknessMultiplier", v)}
            />
            <ControlRow
              label="text fade threshold"
              value={graphConfig.display.labelFadeThreshold}
              min={0.3}
              max={3}
              step={0.05}
              onChange={(v) => updateDisplay("labelFadeThreshold", v)}
            />
            <div className="graphControlRow">
              <div className="graphControlMeta">
                <span className="graphControlLabel">edge labels</span>
              </div>
              <div className="graphSegment">
                {(["off", "predicates", "all"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`graphSegmentBtn ${
                      graphConfig.display.edgeLabels === mode ? "graphSegmentBtnActive" : ""
                    }`}
                    onClick={() => updateDisplay("edgeLabels", mode)}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="graphControlSection">
        <button
          type="button"
          className="graphControlSectionButton"
          onClick={() => setIsForcesOpen((v) => !v)}
        >
          {isForcesOpen ? (
            <ChevronDown size={13} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} />
          )}
          forces
        </button>
        {isForcesOpen && (
          <div className="graphControlRows">
            <ControlRow
              label="center force"
              value={graphConfig.forces.centerForce}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateForce("centerForce", v)}
            />
            <ControlRow
              label="repel force"
              value={graphConfig.forces.repelForce}
              min={200}
              max={1200}
              step={10}
              onChange={(v) => updateForce("repelForce", v)}
            />
            <ControlRow
              label="link force"
              value={graphConfig.forces.linkForce}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateForce("linkForce", v)}
            />
            <ControlRow
              label="link distance"
              value={graphConfig.forces.linkDistance}
              min={30}
              max={500}
              step={2}
              onChange={(v) => updateForce("linkDistance", v)}
            />
          </div>
        )}
      </section>
    </div>
  );
}
