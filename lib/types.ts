export type Role = "ADMIN" | "MANAGER" | "CONFIRMATION_AGENT" | "OPERATIONS" | "WAREHOUSE" | "VIEWER";
export type ConfirmationRejectionReason =
  | "wrong_item"
  | "changed_mind"
  | "price_issue"
  | "duplicate_order"
  | "delivery_delay"
  | "ordered_by_mistake"
  | "unreachable"
  | "other";
export type CampaignUrgency = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type CampaignDuplicateMode = "NONE" | "NAME_PHONE_PRODUCT" | "SHOPIFY_CUSTOMER_PRODUCT" | "PHONE_OR_ADDRESS_PRODUCT";

export interface CampaignCriteria {
  duplicateOnly: boolean;
  duplicateMode: CampaignDuplicateMode;
  tags: string[];
  orderNumbers: string[];
  productNames: string[];
  paymentMethod: "ANY" | "COD" | "Prepaid";
  previousUnfulfilledOnly: boolean;
  includeRtoRisk: boolean;
  autoAssignFutureMatching: boolean;
}

export type OpsBlocker =
  | "invalid-SKU"
  | "confirmation-pending"
  | "Shiprocket-missing"
  | "AWB-missing"
  | "label-missing"
  | "integration-error"
  | "recipe-missing"
  | "packaging-plan-required"
  | "component-shortage";

export type ComponentType = string;
export interface ComponentTypeView { code: string; name: string; }

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  mustChangePassword?: boolean;
}

export interface UserDeleteInfo {
  canHardDelete: boolean;
  historyCount: number;
  reason: string | null;
  references: Array<{ label: string; count: number }>;
}

export interface UserAdminView extends AppUser {
  deleteInfo?: UserDeleteInfo;
}

export interface OrderLineView {
  id: string;
  productId: string | null;
  sku: string;
  name: string;
  quantity: number;
  allocatedQuantity: number;
}

export interface OrderView {
  id: string;
  shopifyCustomerId: string | null;
  orderNumber: string;
  customerName: string;
  customerPhone: string | null;
  customerAddress: string | null;
  shopifyTags: string[];
  paymentMethod: string;
  amount: number;
  status: string;
  currentStatus: string;
  rtoRisk: string | null;
  rtoScore: number | null;
  confirmationSelected: boolean;
  confirmationStatus: string;
  assignedUserId: string | null;
  assignedUserName: string | null;
  shiprocketOrderId: string | null;
  shipmentId: string | null;
  manifestedAt: string | null;
  pickedUpAt: string | null;
  latestShipmentEventAt: string | null;
  latestLabelEventAt: string | null;
  autoCancelDeadline: string | null;
  courierAutoCancelDays: number | null;
  awb: string | null;
  courier: string | null;
  trackingStatus: string | null;
  cancellationSource: string | null;
  cancellationReason: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  labelKey: string | null;
  warehouseAcknowledged: boolean;
  rtoEta: string | null;
  stuckReason: string | null;
  stuckNotes: string | null;
  createdAt: string;
  updatedAt: string;
  lines: OrderLineView[];
  blocker: OpsBlocker | null;
  processed: boolean;
  requirementStatus: "missing" | "packaging-required" | "complete" | null;
  packagingPlanStatus: string | null;
  requirements: Array<{ id: string; orderLineId: string | null; componentId: string; sku: string; name: string; source: "BOM" | "COURIER_BOX"; requiredQuantity: number; allocatedQuantity: number; missingQuantity: number }>;
  shortageSummary: string | null;
  assignedCampaign: { id: string; name: string; urgency: CampaignUrgency; assignedAgentId: string; assignedAgentName: string | null; createdAt: string; position: number; orderPosition: number; criteria: CampaignCriteria | null } | null;
  confirmationAttempts: Array<{ id: string; attemptNumber: number; outcome: string; callPicked: boolean; rejectionReason: ConfirmationRejectionReason | null; note: string | null; callbackAt: string | null; nextActionAt: string | null; createdAt: string; userId: string; userName: string | null }>;
  pendingEditRequests: Array<{ id: string; fieldName: string; oldValue: string | null; newValue: string; createdAt: string; requestedBy: string; requestedByName: string | null; status: "PENDING" | "APPROVED" | "REJECTED" }>;
}

export interface InventoryView {
  id: string;
  sku: string;
  name: string;
  variant: string;
  onHand: number;
  allocated: number;
  available: number;
  incomingRto: number;
  expectedRtoDate: string | null;
  componentType: ComponentType;
  unit: string;
  rtoRecoverable: boolean;
  requiredBy: Array<{ productId: string; productName: string; productSku: string; quantity: number }>;
}

export interface RtoTaskView {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  units: number;
  status: string;
  eta: string | null;
  outcome: string | null;
  lines: Array<{ id: string; name: string; sku: string; quantity: number; hasSnapshot: boolean }>;
}

export interface RtoOrderView {
  id: string;
  orderNumber: string;
  customerName: string;
  status: string;
  currentStatus: string;
  awb: string | null;
  courier: string | null;
  eta: string | null;
  updatedAt: string;
  lines: Array<{ id: string; sku: string; name: string; quantity: number }>;
}

export interface SellableProductView { id: string; sku: string; name: string; variant: string; recipeVersion: number | null; recipeId: string | null; packagingProfileId: string | null; packingUnits: number; recipeItems: Array<{ componentId: string; quantity: number }>; buildableUnits: number; shopifyVariantId?: string | null; isManual?: boolean; }
export interface PackagingProfileView { id: string; name: string; boxes: Array<{ id: string; componentId: string; componentName: string; componentSku: string; capacity: number }> }
export interface ManualSaleView { id: string; reference: string; productId: string; productSku: string; productName: string; quantity: number; status: "dispatched" | "delivered" | "rto"; createdByName: string | null; createdAt: string; updatedAt: string; }
export interface InventoryLogView { id: string; componentId: string; componentSku: string; componentName: string; movementType: string; quantity: number; reason: string; actorName: string | null; createdAt: string; }
export interface ShipmentEventView { id: string; orderId: string | null; awb: string; status: string; statusCode: string | null; courier: string | null; occurredAt: string; receivedAt: string; }
export interface CampaignView {
  id: string;
  name: string;
  description: string | null;
  urgency: CampaignUrgency;
  assignedAgentId: string;
  assignedAgentName: string | null;
  criteria: CampaignCriteria | null;
  position: number;
  isActive: boolean;
  createdAt: string;
  createdByName: string | null;
  assignedOrders: number;
}
export interface PendingEditRequestView {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string;
  createdAt: string;
  requestedBy: string;
  requestedByName: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
}
export interface RecallCooldownSettingsView {
  defaultHours: number;
  updatedAt: string | null;
  updatedByName: string | null;
}
export interface RecallOverrideView {
  id: string;
  orderId: string;
  orderNumber: string;
  overriddenByName: string | null;
  reason: string;
  originalNextActionAt: string | null;
  newNextActionAt: string;
  createdAt: string;
}

export interface DashboardSnapshot {
  currentUser: AppUser;
  generatedAt: string;
  campaignManualOrderActive: boolean;
  metrics: {
    processedToday: number;
    leftToProcess: number;
    confirmationBacklog: number;
    inventoryShortages: number;
    delivered: number;
    rtoUnits: number;
  };
  blockers: Array<{ key: string; label: string; count: number }>;
  orders: OrderView[];
  orderPagination: { limit: number; nextOffset: number; total: number; hasMore: boolean };
  fulfillmentCounts: { total: number; newOrders: number; labelsGenerated: number; shipped: number; confirmedOrders: number };
  inventory: InventoryView[];
  componentTypes: ComponentTypeView[];
  rtoTasks: RtoTaskView[];
  rtoOrders: RtoOrderView[];
  users: UserAdminView[];
  integrations: Array<{ provider: string; status: string; detail: string | null; lastSyncedAt: string | null }>;
  orderFreshness: { latestOrderAt: string | null; ageHours: number | null };
  recentAudit: Array<{ id: string; action: string; detail: string | null; createdAt: string; actorName: string | null }>;
  sampleMode: boolean;
  products: SellableProductView[];
  packagingProfiles: PackagingProfileView[];
  manualSales: ManualSaleView[];
  inventoryLog: InventoryLogView[];
  shipmentEvents: ShipmentEventView[];
  campaigns: CampaignView[];
  pendingEditRequests: PendingEditRequestView[];
  recallCooldownSettings: RecallCooldownSettingsView;
  recallOverrides: RecallOverrideView[];
}
