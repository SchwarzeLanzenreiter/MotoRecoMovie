/** 名前・スライダー・数値入力・単位の 1 行 */
export function Slider(props: { name: string; value: number; min: number; max: number; step: number; unit?: string; disabled?: boolean; onChange: (v: number) => void }): React.JSX.Element {
  const { name, value, min, max, step, unit, disabled, onChange } = props
  return (
    <div className="row">
      <label className="name">{name}</label>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <input
        type="number"
        value={Number(value.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0))}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
      <span className="unit">{unit}</span>
    </div>
  )
}
