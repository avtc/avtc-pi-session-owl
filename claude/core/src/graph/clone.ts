// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Node, Observation } from "../types.js";

export function cloneNode(node: Node): Node {
  return {
    ...node,
    observationIds: [...node.observationIds],
    childNodeIds: [...node.childNodeIds],
    supersededBy: node.supersededBy,
    timestamps: { ...node.timestamps },
  };
}

export function cloneObservation(obs: Observation): Observation {
  return {
    ...obs,
    sourceEntryIds: [...obs.sourceEntryIds],
  };
}
