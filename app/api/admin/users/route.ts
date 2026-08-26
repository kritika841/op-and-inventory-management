import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { audit, ensureDatabase, getEnv, requiredEnv } from "@/lib/database";
import { hashPassword, randomHex } from "@/lib/crypto";
import type { Role } from "@/lib/types";
import { getUserDeleteGuard, getUserDeleteGuards } from "@/lib/users";

const roles: Role[] = ["ADMIN", "MANAGER", "CONFIRMATION_AGENT", "OPERATIONS", "WAREHOUSE", "VIEWER"];

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;
  const actor = auth.user;
  const body = await request.json() as { action?: string; id?: string; email?: string; name?: string; role?: Role; temporaryPassword?: string };
  await ensureDatabase();
  const db = getEnv().DB;
  const adminOnlyAction = body.action === "delete" || body.action === "deactivate" || (!body.action || body.action === "create");

  if (actor.role === "MANAGER" && adminOnlyAction) {
    return Response.json({ error: "Managers can review users and reset passwords, but only admins can add, deactivate, or permanently delete people." }, { status: 403 });
  }

  if (body.action === "deactivate" && body.id) {
    if (body.id === actor.id) return Response.json({ error: "You cannot deactivate your own account" }, { status: 400 });
    const target = await db.prepare("SELECT id,name,role,active FROM users WHERE id=?1").bind(body.id).first<{ id: string; name: string; role: Role; active: number }>();
    if (!target) return Response.json({ error: "User not found" }, { status: 404 });
    if (!Number(target.active)) return Response.json({ error: "User is already inactive" }, { status: 409 });
    if (["ADMIN", "MANAGER"].includes(target.role)) {
      const adminCount = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role IN ('ADMIN','MANAGER') AND active=1").first<{ count: number }>();
      if (Number(adminCount?.count ?? 0) <= 1) return Response.json({ error: "At least one active admin account must remain" }, { status: 400 });
    }

    await db.batch([
      db.prepare("UPDATE users SET active=0,must_change_password=1,failed_attempts=0,locked_until=NULL WHERE id=?1").bind(body.id),
      db.prepare("DELETE FROM sessions WHERE user_id=?1").bind(body.id),
      db.prepare(`UPDATE orders
        SET assigned_user_id=NULL,
            confirmation_status=CASE WHEN confirmation_status='assigned' THEN 'selected' ELSE confirmation_status END,
            updated_at=?1
        WHERE assigned_user_id=?2`)
        .bind(new Date().toISOString(), body.id),
    ]);
    await audit(actor.id, "user.deactivated", "user", body.id, `${target.name} · ${target.role}`);
    return Response.json({ ok: true });
  }

  if (body.action === "delete" && body.id) {
    if (body.id === actor.id) return Response.json({ error: "You cannot permanently delete your own account" }, { status: 400 });
    const target = await db.prepare("SELECT id,name,role,active FROM users WHERE id=?1").bind(body.id).first<{ id: string; name: string; role: Role; active: number }>();
    if (!target) return Response.json({ error: "User not found" }, { status: 404 });
    if (["ADMIN", "MANAGER"].includes(target.role)) {
      const adminCount = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role IN ('ADMIN','MANAGER') AND active=1").first<{ count: number }>();
      if (Number(adminCount?.count ?? 0) <= 1 && Number(target.active)) {
        return Response.json({ error: "At least one active admin account must remain" }, { status: 400 });
      }
    }
    const deleteGuard = getUserDeleteGuard(await getUserDeleteGuards(), body.id);
    if (!deleteGuard.canHardDelete && Number(target.active)) {
      return Response.json({ error: `Deactivate ${target.name} first, then delete permanently. Historical references will stay preserved in audit records.`, historyCount: deleteGuard.historyCount, references: deleteGuard.references }, { status: 409 });
    }

    await db.batch([
      db.prepare("DELETE FROM sessions WHERE user_id=?1").bind(body.id),
      db.prepare("DELETE FROM users WHERE id=?1").bind(body.id),
    ]);
    await audit(actor.id, "user.deleted", "user", body.id, `${target.name} · ${target.role}`);
    return Response.json({ ok: true, deleted: true });
  }

  if (!body.temporaryPassword || body.temporaryPassword.length < 10) {
    return Response.json({ error: "Temporary password must be at least 10 characters" }, { status: 400 });
  }

  const salt = randomHex(16);
  const passwordHash = await hashPassword(body.temporaryPassword, salt, requiredEnv("PASSWORD_PEPPER"));
  if (body.action === "reset" && body.id) {
    await db.batch([
      db.prepare("UPDATE users SET password_hash=?1,password_salt=?2,must_change_password=1,failed_attempts=0,locked_until=NULL WHERE id=?3").bind(passwordHash, salt, body.id),
      db.prepare("DELETE FROM sessions WHERE user_id=?1").bind(body.id),
    ]);
    await audit(actor.id, "user.password-reset", "user", body.id, "Temporary password issued");
    return Response.json({ ok: true });
  }
  if (!body.email || !body.name || !body.role || !roles.includes(body.role)) return Response.json({ error: "Name, email and valid role are required" }, { status: 400 });
  const id = `usr_${randomHex(8)}`;
  try {
    await db.prepare("INSERT INTO users (id,email,name,role,password_hash,password_salt,must_change_password,active,failed_attempts,created_at) VALUES (?1,?2,?3,?4,?5,?6,1,1,0,?7)").bind(id, body.email.trim().toLowerCase(), body.name.trim(), body.role, passwordHash, salt, new Date().toISOString()).run();
  } catch { return Response.json({ error: "A user with that email already exists" }, { status: 409 }); }
  await audit(actor.id, "user.created", "user", id, `${body.name} · ${body.role}`);
  return Response.json({ ok: true });
}
