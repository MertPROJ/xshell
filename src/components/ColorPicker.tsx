import { useRef } from "react";
import { Check, Pencil } from "lucide-react";
import { useTooltip, ttProps } from "./Tooltip";

// Discord-inspired palette, 12 per row × 2 rows. First entry in each row covers the
// "bright" shade; the second row is a muted/darker variant of the first.
export const PRESET_COLORS: string[] = [
  "#1ABC9C", "#2ECC71", "#3498DB", "#9B59B6", "#E91E63", "#E74C3C",
  "#F39C12", "#F1C40F", "#16A085", "#27AE60", "#95A5A6", "#7F8C8D",
  "#0E6655", "#1E8449", "#1F618D", "#633974", "#A93226", "#B03A2E",
  "#9C640C", "#B7950B", "#0B5345", "#186A3B", "#5D6D7E", "#34495E",
];

interface ColorPickerProps {
  value: string | undefined;           // undefined = default (no custom color)
  onChange: (color: string | undefined) => void;
  label?: string;                       // defaults to "Color"
}

export function ColorPicker({ value, onChange, label = "Color" }: ColorPickerProps) {
  // Hidden native color input we trigger from the "custom" swatch.
  const customInputRef = useRef<HTMLInputElement>(null);
  const { tt, Tooltip } = useTooltip();
  const isDefault = !value;
  const isCustom = !!value && !PRESET_COLORS.includes(value.toUpperCase()) && !PRESET_COLORS.includes(value.toLowerCase()) && !PRESET_COLORS.some(c => c.toLowerCase() === value.toLowerCase());

  return (
    <div className="color-picker">
      <label className="edit-label">{label}</label>
      <div className="color-picker-grid">
        {/* Default swatch (reverts to theme default) */}
        <button
          type="button"
          className={`color-swatch color-swatch-default ${isDefault ? "active" : ""}`}
          onClick={() => onChange(undefined)}
          {...ttProps(tt, "Default")}
        >
          {isDefault && <Check size={14} />}
        </button>
        {/* Custom color picker — opens the native color input */}
        <button
          type="button"
          className={`color-swatch color-swatch-custom ${isCustom ? "active" : ""}`}
          style={isCustom && value ? { background: value } : undefined}
          onClick={() => customInputRef.current?.click()}
          {...ttProps(tt, isCustom && value ? `Custom: ${value.toUpperCase()}` : "Custom color")}
        >
          {!isCustom && <Pencil size={12} />}
          {isCustom && <Check size={14} style={{ color: "#fff", filter: "drop-shadow(0 0 2px rgba(0,0,0,0.6))" }} />}
        </button>
        <input
          ref={customInputRef}
          type="color"
          className="color-picker-native"
          value={value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#3498DB"}
          onChange={(e) => onChange(e.target.value)}
        />
        {PRESET_COLORS.map(c => {
          const isActive = value?.toLowerCase() === c.toLowerCase();
          return (
            <button
              key={c}
              type="button"
              className={`color-swatch ${isActive ? "active" : ""}`}
              style={{ background: c }}
              onClick={() => onChange(c)}
              {...ttProps(tt, c)}
            >
              {isActive && <Check size={14} style={{ color: "#fff", filter: "drop-shadow(0 0 2px rgba(0,0,0,0.6))" }} />}
            </button>
          );
        })}
      </div>
      {Tooltip}
    </div>
  );
}
