import { useContext } from "react";
import { RepairContext } from "./Repair";
import type { ModEntry } from "../lib/types";

/**
 * Turn one mod on or off, wherever it is named.
 *
 * Every surface in this app that says a mod is the likely cause of something used to name
 * it and stop there: the Home summary, the Library, the tick cost table, the save
 * comparison, the mod's own detail panel. Acting on it meant going to the Load order tab
 * and finding it again in a list of 253, which is enough friction that the naming may as
 * well not have happened.
 *
 * It edits the modpack, not the game. Nothing on disk changes until Apply to game, so this
 * is as reversible as any other change to the working order.
 */
export function ToggleMod({ mod, className }: { mod: ModEntry; className?: string }) {
  const api = useContext(RepairContext);
  if (!api) return null;

  const order = api.modpack.activeOrder;
  const enabled = order.some((id) => id.toLowerCase() === mod.packageId.toLowerCase());

  // Turning off something other mods declare they need breaks them, so the button says so
  // rather than refusing: the person looking at this screen knows what they are doing more
  // often than not, and a disabled button with no explanation helps nobody.
  const dependents = enabled
    ? api.scan.mods.filter(
        (m) =>
          order.some((id) => id.toLowerCase() === m.packageId.toLowerCase()) &&
          m.dependencies.some((d) => d.packageId.toLowerCase() === mod.packageId.toLowerCase()),
      )
    : [];

  function toggle() {
    if (!api) return;
    const next = enabled
      ? order.filter((id) => id.toLowerCase() !== mod.packageId.toLowerCase())
      : [...order, mod.packageId];
    api.applyModpack(
      { ...api.modpack, activeOrder: next },
      enabled ? `disable ${mod.name}` : `enable ${mod.name}`,
    );
  }

  return (
    <button
      className={className ?? (enabled ? "btn danger small" : "btn go small")}
      type="button"
      title={
        dependents.length
          ? `${dependents.length} active mod${dependents.length === 1 ? "" : "s"} declare they need this: ${dependents
              .slice(0, 4)
              .map((m) => m.name)
              .join(", ")}${dependents.length > 4 ? ", and more" : ""}`
          : "Changes the modpack only. Apply to game writes it out."
      }
      onClick={toggle}
    >
      {enabled ? "Disable it" : "Enable it"}
      {dependents.length > 0 && <span className="tier">{dependents.length} need it</span>}
    </button>
  );
}
