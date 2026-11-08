export type AlertKind =
  | "error"
  | "incomplete"
  | "relaxed"
  | "dropped_properties"
  | "declined"
  | "no_data";

/**
 * Only failures are live ("alert", announced once). Informational notes use the non-live "note"
 * role because the status region already announces the phase.
 */
export function alertRole(kind: AlertKind): "alert" | "note" {
  return kind === "error" || kind === "incomplete" ? "alert" : "note";
}
