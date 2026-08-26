import type { OpsBlocker } from "./types";
type DomainOrder = { status: string; trackingStatus?: string | null; lines: Array<{ id?: string; productId?: string | null; sku: string; quantity: number; allocatedQuantity: number }>; requirementStatus?: string | null; requirements?: Array<{ requiredQuantity: number; allocatedQuantity: number }>; confirmationSelected: boolean; confirmationStatus: string; shiprocketOrderId: string | null; awb: string | null; labelKey: string | null };
export function deriveBlocker(order: DomainOrder): OpsBlocker | null;
export function isProcessed(order: DomainOrder): boolean;
export function inventoryAvailability(onHand: number, allocated: number): number;
export function calculateBoxPlan(units: number, boxes: Array<{ componentId: string; capacity: number }>): Array<{ componentId: string; quantity: number }> | null;
export function projectRtoEta(shiprocketEta: string | null, initiatedAt: string, historicalMedianDays?: number | null, fallbackDays?: number): { date: string; estimated: boolean };
