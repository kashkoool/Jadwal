import { Injectable, ForbiddenException, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto } from './dto/query-params.dto';
import { ExportPaginationDto } from '../common/dto/pagination.dto';
import { LoyaltyUserQueryDto } from './dto/loyalty-user-query.dto';
import { Prisma } from '@prisma/client';
import { CreateCountryDto, UpdateCountryDto } from './dto/country.dto';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { CreateCityDto, UpdateCityDto } from './dto/city.dto';
import { CreateTrendingEventDto, UpdateTrendingEventDto } from './dto/trending-event.dto';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdatePlatformSettingsDto } from './dto/platform-settings.dto';
import { UpdateActivityDto } from './dto/update-activity.dto';
import { CreateActivityBlockDto } from '../vendor/dto/create-activity-block.dto';
import { CreateSpecialPriceDto } from '../vendor/dto/create-special-price.dto';
import { BulkSpecialPriceDto } from '../vendor/dto/bulk-special-price.dto';
import { createActivityBlockCore } from '../vendor/activity-blocks.logic';
import { createSpecialPriceCore, bulkCreateSpecialPricesCore } from '../vendor/activity-special-prices.logic';
import { NotificationService } from '../common/services/notification.service';
import { LoyaltyService } from '../common/services/loyalty.service';
import { AvailabilityCacheService } from '../redis/availability-cache.service';
import { ReferenceDataCacheService } from '../redis/reference-data-cache.service';
import { SessionDenylistService } from '../redis/session-denylist.service';
import { assertHourlyTimesConsistent } from '../common/validators/hourly-activity';
import { nowInTimezone } from '../common/validators/timezone';
import { refundCouponUsage, addMonthsClamped } from '../bookings/bookings.service';
import { envNumber } from '../common/env';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private notificationService: NotificationService,
    private loyalty: LoyaltyService,
    private availabilityCache: AvailabilityCacheService,
    private refCache: ReferenceDataCacheService,
    private sessionDenylist: SessionDenylistService,
  ) {}

  // ─── Admin Profile ──────────────────────────────────────────
  async getAdminProfile(userId: string) {
    return this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, email: true, phone: true, role: true, createdAt: true },
    });
  }

  async updateAdminProfile(userId: string, data: { fullName?: string; phone?: string }) {
    const allowed: Record<string, any> = {};
    if (data.fullName) allowed.fullName = data.fullName;
    if (data.phone !== undefined) allowed.phone = data.phone;
    return this.prisma.client.user.update({
      where: { id: userId },
      data: allowed,
      select: { id: true, fullName: true, email: true, phone: true },
    });
  }

  async changeAdminPassword(userId: string, currentPassword: string, newPassword: string) {
    const db = this.prisma.client;
    // Opt back into password (globally omitted in PrismaService) for bcrypt compare.
    const user = await db.user.findUnique({
      where: { id: userId },
      omit: { password: false },
    } as any) as { id: string; password: string | null } | null;
    if (!user) throw new NotFoundException('User not found');
    if (!user.password) throw new ForbiddenException('This account uses Google sign-in and has no password.');
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new ForbiddenException('Current password is incorrect');
    const bcryptRounds = Number(process.env.BCRYPT_ROUNDS || 12);
    const hash = await bcrypt.hash(newPassword, bcryptRounds);
    // M5 — denylist every live session BEFORE the tx deletes the refresh rows,
    // so outstanding access tokens die immediately too (not just at renewal).
    await this.sessionDenylist.denylistAllUserSessions(userId);
    // Interactive transaction (function form) — preferred over the array form
    // with Prisma 7 driver adapters.
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { password: hash } });
      // Invalidate all refresh tokens — forces re-login on all other sessions
      await tx.refreshToken.deleteMany({ where: { userId } });
    });
    return { message: 'Password updated successfully. Please log in again.' };
  }

  // ─── Loyalty (WANASA) ─────────────────────────────────────────
  async getLoyaltyConfig() {
    const db = this.prisma.client;
    let config = await db.loyaltyConfig.findUnique({ where: { id: 'singleton' } });
    if (!config) {
      config = await db.loyaltyConfig.create({ data: { id: 'singleton' } });
    }
    return config;
  }

  async updateLoyaltyConfig(data: { pointsPerQar?: number; qarPerPoint?: number; minRedemption?: number }) {
    return this.prisma.client.loyaltyConfig.upsert({
      where: { id: 'singleton' },
      update: data,
      create: { id: 'singleton', ...data },
    });
  }

  async getLoyaltyUsers(query: LoyaltyUserQueryDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search, sort = 'desc' } = query;
    const skip = (page - 1) * limit;
    const where: any = { role: 'CUSTOMER' };
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    // `sort` is whitelisted at the DTO ('desc' | 'asc'), so no risk of a
    // caller injecting arbitrary Prisma order directions.
    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        select: { id: true, fullName: true, email: true, loyaltyPoints: true },
        orderBy: { loyaltyPoints: sort },
        skip,
        take: limit,
      }),
      db.user.count({ where }),
    ]);
    // loyaltyPoints is a Decimal column (QAR-denominated) — normalise to a JS
    // number so the admin table receives a JSON number, not a Decimal string.
    const data = users.map((u) => ({ ...u, loyaltyPoints: Number(u.loyaltyPoints) }));
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Admin manual adjustment to a user's loyalty-point balance.
   * Writes a LoyaltyLedger row with source ADMIN_ADJUST (actor = the admin).
   * Delta is bounded by DTO (-1_000_000..+1_000_000) and clamped to not
   * drive the balance below zero — LoyaltyService records both the
   * requested delta and the applied delta in the reason line when clamped.
   */
  async adjustUserPoints(userId: string, delta: number, reason: string, actorId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new NotFoundException('User not found');

      const result = await this.loyalty.adjust(tx, {
        userId,
        delta,
        actorType: 'ADMIN',
        actorId,
        reason,
      });

      const fresh = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, fullName: true, loyaltyPoints: true },
      });
      return { ...fresh, loyaltyPoints: Number(fresh.loyaltyPoints), appliedDelta: result.appliedDelta };
    });
  }

  // ─── Dashboard Stats ────────────────────────────────────────
  async getDashboardStats(range?: string) {
    const db = this.prisma.client;

    // Period window for the TRANSACTIONAL KPIs (revenue / volume / commission /
    // fees / booking counts) so the dashboard never sums the entire booking +
    // payment history on a default load. Default 30 days; 'all' = lifetime (the
    // old behaviour, explicit opt-in). Structural counts (users / vendors /
    // activities) and current liabilities (payout owed / points / refunds) are
    // NOT windowed — they are point-in-time snapshots, not period sums.
    const allowedDays: Record<string, number> = { '30': 30, '60': 60, '90': 90 };
    const windowDays = allowedDays[range ?? '30'] ?? 30;
    const cutoff = range === 'all' ? null : new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const createdWindow = cutoff ? { createdAt: { gte: cutoff } } : {};

    const [
      totalUsers,
      totalVendors,
      activeVendors,
      pendingVendors,
      totalActivities,
      pendingActivities,
      totalBookings,
      confirmedBookings,
      revenueResult,
      volumeResult,
      // New: financial-health KPIs. See the matching cards on the admin
      // dashboard — platform revenue decomposition + liability exposure.
      commissionResult,
      serviceFeeResult,
      pendingVendorBalance,
      pointsIssued,
      refundPendingStats,
    ] = await Promise.all([
      db.user.count(),
      db.vendor.count(),
      db.vendor.count({ where: { status: 'ACTIVE' } }),
      db.vendor.count({ where: { status: 'PENDING' } }),
      db.activity.count(),
      db.activity.count({ where: { status: 'PENDING' } }),
      db.booking.count({ where: createdWindow }),
      db.booking.count({ where: { status: 'CONFIRMED', ...createdWindow } }),
      // Cash collected (PAY2M-settled portion). Wanasa-only bookings have
      // payment.amount=0 so they correctly do NOT count toward cash revenue.
      db.payment.aggregate({ where: { status: 'SUCCESS', ...createdWindow }, _sum: { amount: true } }),
      // Full platform volume. totalPrice already carries the vendor's
      // full earned amount (regardless of how the customer paid), so we
      // only add back couponDiscount to reconstruct the nominal activity
      // value. pointsDiscount is NOT added — it's a customer-side saving,
      // not a deduction from vendor revenue.
      db.booking.aggregate({
        where: { payment: { status: 'SUCCESS' }, ...createdWindow },
        _sum: { totalPrice: true, pointsDiscount: true, couponDiscount: true },
      }),
      // Commission earned by the platform — lifetime gross margin on
      // every successfully-paid booking regardless of payout status.
      db.booking.aggregate({
        where: { payment: { status: 'SUCCESS' }, ...createdWindow },
        _sum: { commissionAmount: true },
      }),
      // Service fee earned by the platform. Zero on Wanasa-paid bookings
      // (fee is waived as a loyalty incentive), so this represents only
      // the cash-path fee revenue.
      db.booking.aggregate({
        where: { payment: { status: 'SUCCESS' }, ...createdWindow },
        _sum: { serviceFee: true },
      }),
      // Pending vendor payout balance: what the platform OWES vendors.
      // SUCCESS + UNPAID bookings' vendor share. When this grows large,
      // admin needs to process payouts (or the platform is building up
      // a liability balance).
      db.booking.aggregate({
        where: { payment: { status: 'SUCCESS', payoutStatus: 'UNPAID' } },
        _sum: { totalPrice: true, commissionAmount: true },
      }),
      // Total loyalty points currently in circulation — the platform's
      // redemption liability. Each point is worth qarPerPoint in future
      // booking credit, so this × qarPerPoint = QAR on the hook.
      db.user.aggregate({ _sum: { loyaltyPoints: true } }),
      // Refund exposure: PENDING refund decisions awaiting vendor/admin
      // action. High count = risk of customer-support escalations.
      db.payment.aggregate({
        where: { status: 'REFUND_PENDING' },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    // wanasaFundedValue = how many QAR of customer spend came via points.
    // Still reported as an audit-only metric so admin can see what portion
    // of overall volume flowed through loyalty redemption — but it's NOT
    // added to totalPrice (that would double-count under the new vendor
    // accounting).
    const wanasaFundedValue = Number(volumeResult._sum.pointsDiscount ?? 0);
    const bookingsValue =
      Number(volumeResult._sum.totalPrice ?? 0) +
      Number(volumeResult._sum.couponDiscount ?? 0);
    const totalCommission = Number(commissionResult._sum.commissionAmount ?? 0);
    const totalServiceFees = Number(serviceFeeResult._sum.serviceFee ?? 0);
    const pendingPayoutOwed =
      Number(pendingVendorBalance._sum.totalPrice ?? 0) -
      Number(pendingVendorBalance._sum.commissionAmount ?? 0);
    const totalPointsIssued = Number(pointsIssued._sum.loyaltyPoints ?? 0);

    return {
      totalUsers,
      totalVendors,
      activeVendors,
      pendingVendors,
      totalActivities,
      pendingActivities,
      totalBookings,
      confirmedBookings,
      totalRevenue: revenueResult._sum.amount ?? 0,
      bookingsValue,
      wanasaFundedValue,
      // New financial KPIs
      totalCommission,
      totalServiceFees,
      pendingPayoutOwed,
      totalPointsIssued,
      refundPendingCount: refundPendingStats._count ?? 0,
      refundPendingAmount: Number(refundPendingStats._sum.amount ?? 0),
      // Echo the applied window so the UI can label the period cards.
      range: cutoff ? String(windowDays) : 'all',
    };
  }

  // ─── Users ──────────────────────────────────────────────────
  async getUsers(query: PaginationDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search, status, role, verified, includeDeleted } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {};
    // Hide soft-deleted (anonymised) users unless explicitly requested. The
    // rows are retained for PDPL/GDPR financial-audit, but they shouldn't
    // clutter the default admin list.
    if (includeDeleted !== 'true') where.deletedAt = null;
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    // The users page filters by role. `role` is the accurate param; `status`
    // remains a backward-compat fallback (it historically carried the role value).
    const roleFilter = role ?? status;
    if (roleFilter) {
      where.role = roleFilter as any;
    }
    if (verified === 'verified') where.emailVerified = true;
    else if (verified === 'unverified') where.emailVerified = false;

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        select: {
          id: true, fullName: true, email: true, phone: true,
          role: true, isDeactivated: true, emailVerified: true, createdAt: true,
          termsAcceptedAt: true, termsAcceptedVersion: true, deletedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.user.count({ where }),
    ]);

    return { data: users, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateUserRole(userId: string, role: any) {
    const db = this.prisma.client;
    // Protect admin accounts from role changes
    const target = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'ADMIN') throw new ForbiddenException('Cannot modify admin user roles');

    const result = await db.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, fullName: true, email: true, role: true },
    });
    // Invalidate all sessions so the user gets a new JWT with the updated role.
    // Denylist FIRST (M5) so any already-issued access token carrying the OLD
    // role is rejected immediately, not ≤JWT_EXPIRATION later.
    await this.sessionDenylist.denylistAllUserSessions(userId);
    await db.refreshToken.deleteMany({ where: { userId } });
    return result;
  }

  async deactivateUser(userId: string, isDeactivated: boolean) {
    const db = this.prisma.client;
    // Protect admin accounts from deactivation
    const target = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'ADMIN') throw new ForbiddenException('Cannot deactivate admin users');

    const result = await db.user.update({
      where: { id: userId },
      data: { isDeactivated },
      select: { id: true, fullName: true, email: true, isDeactivated: true },
    });
    // When deactivating, kill all sessions so the user is immediately logged out
    if (isDeactivated) {
      await this.sessionDenylist.denylistAllUserSessions(userId);
      await db.refreshToken.deleteMany({ where: { userId } });
    }
    return result;
  }

  /**
   * §B9 — soft-delete + PII anonymisation. Replaces the prior hard-delete
   * cascade that wiped Booking + Payment + Review + LoyaltyLedger rows.
   *
   * What happens:
   *   1. Refuse if any PENDING / CONFIRMED booking still references this
   *      user (existing money-loss guard, preserved).
   *   2. Refuse if already soft-deleted (idempotent — no double-anonymise).
   *   3. If the user is a vendor, soft-delete the vendor profile + every
   *      activity (slug renamed to `deleted-<id>` so URLs free up).
   *   4. Anonymise PII on the user row: email → `<id>@deleted.local`,
   *      fullName → 'Deleted User', phone / profilePicture / password /
   *      googleId / *Token / *Hash → null. emailVerified → false and
   *      isDeactivated → true so the row can never be a login target.
   *   5. Hard-delete ephemerals (RefreshToken, PushSubscription,
   *      Notification, ClaimedCoupon, Like) — these are NOT financial /
   *      audit records.
   *   6. KEEP intact: Booking, Payment, LoyaltyLedger, Review, Coupon,
   *      PayoutRequest, AuditLog (Qatar PDPL §14, GDPR Art.30 financial
   *      retention).
   *
   * The customer-facing experience: bookings / reviews / loyalty history
   * tied to this user remain visible to admin under "Deleted User", but
   * the user can no longer log in, no PII is left in the row, and the
   * email / phone / slug they used are freed up for re-registration.
   */
  async deleteUser(userId: string) {
    const db = this.prisma.client;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, role: true, deletedAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === 'ADMIN') throw new ForbiddenException('Cannot delete admin users');
    if (user.deletedAt) {
      // Idempotent: re-deletion is a no-op so a flaky admin click can't
      // re-anonymise (which would do nothing) or worse, reset emailVerified
      // / isDeactivated mid-flight. Return the same shape as a fresh delete.
      return { message: `User "${user.fullName}" has been deleted` };
    }

    // Refuse soft-delete while any unresolved booking exists — preserved
    // money-loss guard. Either side of the booking (customer or vendor)
    // counts as blocking. Cancel / refund those first via the standard
    // flows, OR suspend the vendor to trigger the auto-refund cascade.
    const [asCustomer, asVendor] = await Promise.all([
      db.booking.count({
        where: { customerId: userId, status: { in: ['PENDING', 'CONFIRMED'] } },
      }),
      db.booking.count({
        where: {
          vendor: { userId },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      }),
    ]);
    const totalBlocking = asCustomer + asVendor;
    if (totalBlocking > 0) {
      throw new ForbiddenException(
        `Cannot delete user: ${totalBlocking} unresolved booking(s) (${asCustomer} as customer, ${asVendor} as vendor). Cancel or refund them first.`,
      );
    }

    // M5 — denylist every live session BEFORE the tx deletes the refresh rows,
    // so the soft-deleted account's outstanding access tokens die immediately.
    await this.sessionDenylist.denylistAllUserSessions(userId);

    const affectedActivityIds = await db.$transaction(async (tx: any) => {
      let activityIdsTouched: string[] = [];

      // Vendor profile cascade: soft-delete vendor + all activities. Past
      // bookings + payments + reviews stay attached so the audit trail
      // remains queryable.
      const vendor = await tx.vendor.findUnique({
        where: { userId },
        select: { id: true, slug: true, deletedAt: true },
      });
      if (vendor && !vendor.deletedAt) {
        const activities = await tx.activity.findMany({
          where: { vendorId: vendor.id, deletedAt: null },
          select: { id: true },
        });
        const activityIds = activities.map((a: any) => a.id);
        activityIdsTouched = activityIds;
        for (const aId of activityIds) {
          // Set status=INACTIVE alongside deletedAt so every existing
          // status-based filter (`status: 'ACTIVE'`) naturally hides this
          // row without needing a code change. Slug rename frees the URL.
          await tx.activity.update({
            where: { id: aId },
            data: { deletedAt: new Date(), status: 'INACTIVE', slug: `deleted-${aId}` },
          });
        }
        await tx.vendor.update({
          where: { id: vendor.id },
          data: {
            deletedAt: new Date(),
            // status=SUSPENDED ensures existing `vendor.status === 'ACTIVE'`
            // checks across booking-create / payout-flow / catalog reject
            // this vendor without needing per-site deletedAt audits.
            status: 'SUSPENDED',
            slug: `deleted-${vendor.id}`,
            phone: null,
            whatsapp: null,
            bankDetails: null as any, // Prisma.JsonNull would also work; null clears the column
          },
        });
      }

      // Hard-delete ephemerals — these are session / UX state, NOT
      // financial or audit-trail records:
      //   • RefreshToken / PushSubscription — security-critical: the
      //     soft-deleted account must not retain any active session or
      //     push channel.
      //   • Notification — UX inbox; admin actions are independently
      //     logged via AuditLog.
      //   • ClaimedCoupon / Like — preference / discovery state with no
      //     accounting impact.
      // Booking, Payment, LoyaltyLedger, Review stay attached and
      // continue to reference this user via FK (the row still exists).
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.pushSubscription.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.claimedCoupon.deleteMany({ where: { userId } });
      await tx.like.deleteMany({ where: { userId } });

      // Anonymise PII + mark soft-deleted in one update. Email gets
      // reassigned to a unique sentinel (`<userId>@deleted.local`) so
      // the original address is freed for re-registration without
      // breaking the @unique constraint. Phone / googleId / verification
      // / reset / OTP fields are nulled — Postgres treats multiple NULLs
      // as distinct under @unique so this is safe.
      await tx.user.update({
        where: { id: userId },
        data: {
          email: `${userId}@deleted.local`,
          fullName: 'Deleted User',
          phone: null,
          profilePicture: null,
          password: null,
          googleId: null,
          verificationToken: null,
          verificationTokenExpiry: null,
          passwordResetToken: null,
          passwordResetExpiry: null,
          // Defence in depth — even if a future bug ever surfaces a
          // soft-deleted account in a query that forgot the deletedAt
          // filter, the deactivation flag is a second guard against
          // accidental login.
          isDeactivated: true,
          emailVerified: false,
          deletedAt: new Date(),
        },
      });

      // Customer-side activity-cache invalidation: cancellations on the
      // customer's bookings have already happened earlier in their own
      // flows (this method refuses to run while any are PENDING /
      // CONFIRMED). Past COMPLETED / CANCELLED bookings don't free
      // capacity. Vendor-side: every activity we just soft-deleted
      // needs cache invalidation so in-flight catalog reads see them
      // disappear.
      return activityIdsTouched;
    });

    if (affectedActivityIds.length > 0) {
      void this.availabilityCache.invalidateMany(affectedActivityIds);
    }

    return { message: `User "${user.fullName}" has been deleted` };
  }

  // ─── Vendors ────────────────────────────────────────────────
  async getVendorStats() {
    const db = this.prisma.client;
    const [total, active, pending, suspended] = await Promise.all([
      db.vendor.count(),
      db.vendor.count({ where: { status: 'ACTIVE' } }),
      db.vendor.count({ where: { status: 'PENDING' } }),
      db.vendor.count({ where: { status: 'SUSPENDED' } }),
    ]);
    return { total, active, pending, suspended };
  }

  async getVendors(query: PaginationDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search, status } = query;
    const skip = (page - 1) * limit;

    // Exclude soft-deleted vendors — once an admin deletes a vendor it must
    // disappear from the list (the row is kept only for booking/payment audit).
    const where: Prisma.VendorWhereInput = { deletedAt: null };
    if (search) {
      where.OR = [
        { businessNameEn: { contains: search, mode: 'insensitive' } },
        { businessNameAr: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status) {
      where.status = status as any;
    }

    const [vendors, total] = await Promise.all([
      db.vendor.findMany({
        where,
        include: {
          user: { select: { fullName: true, email: true } },
          country: { select: { nameEn: true, isoCode: true } },
          _count: { select: { activities: true, bookings: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.vendor.count({ where }),
    ]);

    return { data: vendors, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateVendorStatus(vendorId: string, status: any, adminUserId?: string) {
    const db = this.prisma.client;
    const vendor = await db.vendor.update({
      where: { id: vendorId },
      data: { status },
      // slug is needed so the approval notification links to the vendor's
      // portal home. Without it the link resolves to /vendor/dashboard, which
      // 404s because vendor pages are namespaced under /vendor/[slug]/*.
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });
    // When suspending a vendor, kill all their sessions immediately —
    // denylist FIRST (M5) so any outstanding access token dies at once.
    if (status === 'SUSPENDED') {
      await this.sessionDenylist.denylistAllUserSessions(vendor.user.id);
      await db.refreshToken.deleteMany({ where: { userId: vendor.user.id } });
    }

    // Notify vendor about status change
    const typeMap: Record<string, 'VENDOR_APPROVED' | 'VENDOR_SUSPENDED'> = {
      ACTIVE: 'VENDOR_APPROVED',
      SUSPENDED: 'VENDOR_SUSPENDED',
    };
    if (typeMap[status]) {
      this.notificationService.send({
        userId: vendor.user.id,
        type: typeMap[status],
        title: status === 'ACTIVE' ? 'Account Approved' : 'Account Suspended',
        message: status === 'ACTIVE'
          ? 'Your vendor account has been approved. You can now create activities.'
          : 'Your vendor account has been suspended. Please contact support.',
        link: status === 'ACTIVE' ? `/vendor/${vendor.slug}/dashboard` : undefined,
      });
    }

    // Vendor SUSPENDED cascade: their activities must be yanked from the catalog
    // (status = INACTIVE) AND every future paid booking must be cancelled + refunded,
    // otherwise the customer keeps a valid-looking booking for an event that will
    // never happen because the vendor is locked out. adminUserId is required to
    // attribute the cascade in audit + ledger — older callers without it skip the
    // cascade (vendor activation and trust-level changes don't need this path).
    if (status === 'SUSPENDED' && adminUserId) {
      const activities = await db.activity.findMany({
        where: { vendorId, status: { in: ['ACTIVE', 'PENDING'] } },
        select: { id: true, titleEn: true },
        take: 500,
      });
      let totalCancelled = 0;
      for (const a of activities) {
        await db.activity.update({
          where: { id: a.id },
          data: { status: 'INACTIVE' },
        });
        const res = await this.cascadeCancelFutureBookings(
          a.id,
          a.titleEn,
          adminUserId,
          'INACTIVE',
          'Vendor account suspended',
        );
        totalCancelled += res.cancelled;
      }
      if (totalCancelled > 0) {
        this.logger.log(
          `Vendor suspend cascade: ${totalCancelled} booking(s) cancelled across ${activities.length} activity(ies) for vendor ${vendorId}`,
        );
      }
    }

    return vendor;
  }

  async updateVendorTrust(vendorId: string, trustLevel: any) {
    return this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: { trustLevel },
      select: { id: true, businessNameEn: true, trustLevel: true },
    });
  }

  async updateVendorCommission(vendorId: string, commissionPct: number | null | undefined) {
    return this.prisma.client.vendor.update({
      where: { id: vendorId },
      data: { commissionPct: commissionPct ?? null },
      select: { id: true, businessNameEn: true, commissionPct: true },
    });
  }

  /**
   * §B9 — soft-delete vendor + cascade-soft-delete activities + anonymise
   * the underlying user account. Past Booking / Payment / Review /
   * PayoutRequest / Coupon rows stay intact for the 7-year audit window.
   *
   * Slugs (vendor + every activity) are reassigned to `deleted-<id>` so
   * a future vendor signup can reclaim the original public URL. Vendor
   * PII (phone, whatsapp, bankDetails) is nulled out; corporate fields
   * (businessNameEn / businessNameAr / businessId) stay so historical
   * audit records show "this paid booking was on Acme Tours, deleted on
   * 2026-08-11" rather than a dangling FK.
   */
  async deleteVendor(vendorId: string) {
    const db = this.prisma.client;

    const vendor = await db.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, userId: true, businessNameEn: true, deletedAt: true },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (vendor.deletedAt) {
      // Idempotent — same as deleteUser.
      return { message: `Vendor "${vendor.businessNameEn}" and associated user have been deleted` };
    }

    // Money-loss guard preserved: refuse while unresolved bookings exist.
    // Suspending the vendor first triggers the existing refund cascade.
    const blockingBookings = await db.booking.count({
      where: {
        vendorId,
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });
    if (blockingBookings > 0) {
      throw new ForbiddenException(
        `Cannot delete vendor: ${blockingBookings} unresolved booking(s) still exist. Suspend the vendor first to cascade-cancel and refund, then delete.`,
      );
    }

    // §B9 follow-up — block on owed-but-unpaid earnings. Soft-delete sets
    // vendor.status=SUSPENDED, which §M3's mark-paid guard will then
    // reject permanently. Without this check, legitimate vendor earnings
    // on COMPLETED bookings would get stranded with no recovery path.
    // Admin must process those payouts first (via the Payout Requests
    // page or bulk Mark Paid) before deletion is allowed.
    const blockingPayouts = await db.payment.count({
      where: {
        status: 'SUCCESS',
        payoutStatus: 'UNPAID',
        booking: { vendorId },
      },
    });
    if (blockingPayouts > 0) {
      throw new ForbiddenException(
        `Cannot delete vendor: ${blockingPayouts} completed payment(s) still owe payout. Process those payouts first (Payments tab → Mark as Paid), then delete.`,
      );
    }
    // Also refuse if any non-rejected payout request is still in flight —
    // approving/completing it after deletion would create an audit-log
    // entry against an anonymised vendor identity.
    const blockingPayoutRequests = await db.payoutRequest.count({
      where: { vendorId, status: { in: ['PENDING', 'APPROVED'] } },
    });
    if (blockingPayoutRequests > 0) {
      throw new ForbiddenException(
        `Cannot delete vendor: ${blockingPayoutRequests} payout request(s) still in flight. Approve / reject / complete those first, then delete.`,
      );
    }

    // M5 — denylist the vendor's live sessions BEFORE the tx deletes the
    // refresh rows, so the soft-deleted account's access tokens die at once.
    await this.sessionDenylist.denylistAllUserSessions(vendor.userId);

    const activityIdsTouched = await db.$transaction(async (tx: any) => {
      // Soft-delete every active activity, freeing each slug.
      const activities = await tx.activity.findMany({
        where: { vendorId, deletedAt: null },
        select: { id: true },
      });
      const activityIds: string[] = activities.map((a: any) => a.id);
      for (const aId of activityIds) {
        await tx.activity.update({
          where: { id: aId },
          data: { deletedAt: new Date(), status: 'INACTIVE', slug: `deleted-${aId}` },
        });
      }

      // Soft-delete the vendor row, free the slug, null PII. Setting
      // status=SUSPENDED makes every existing `vendor.status === 'ACTIVE'`
      // check across the codebase (booking-create / payout-flow / catalog)
      // naturally reject this vendor without needing per-site audits.
      await tx.vendor.update({
        where: { id: vendorId },
        data: {
          deletedAt: new Date(),
          status: 'SUSPENDED',
          slug: `deleted-${vendorId}`,
          phone: null,
          whatsapp: null,
          bankDetails: null as any,
        },
      });

      // Anonymise the underlying user via the same logic as deleteUser
      // (inlined to avoid recursive-cascade ambiguity — the vendor we
      // just soft-deleted would otherwise be touched twice).
      await tx.refreshToken.deleteMany({ where: { userId: vendor.userId } });
      await tx.pushSubscription.deleteMany({ where: { userId: vendor.userId } });
      await tx.notification.deleteMany({ where: { userId: vendor.userId } });
      await tx.claimedCoupon.deleteMany({ where: { userId: vendor.userId } });
      await tx.like.deleteMany({ where: { userId: vendor.userId } });
      await tx.user.update({
        where: { id: vendor.userId },
        data: {
          email: `${vendor.userId}@deleted.local`,
          fullName: 'Deleted User',
          phone: null,
          profilePicture: null,
          password: null,
          googleId: null,
          verificationToken: null,
          verificationTokenExpiry: null,
          passwordResetToken: null,
          passwordResetExpiry: null,
          isDeactivated: true,
          emailVerified: false,
          deletedAt: new Date(),
        },
      });

      return activityIds;
    });

    if (activityIdsTouched.length > 0) {
      void this.availabilityCache.invalidateMany(activityIdsTouched);
    }

    return { message: `Vendor "${vendor.businessNameEn}" and associated user have been deleted` };
  }

  // ─── Activities ─────────────────────────────────────────────
  async getActivities(query: PaginationDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search, status } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.ActivityWhereInput = {};
    if (search) {
      where.OR = [
        { titleEn: { contains: search, mode: 'insensitive' } },
        { titleAr: { contains: search, mode: 'insensitive' } },
        { vendor: { businessNameEn: { contains: search, mode: 'insensitive' } } },
        { vendor: { businessNameAr: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status) {
      where.status = status as any;
    }

    const [activities, total] = await Promise.all([
      db.activity.findMany({
        where,
        include: {
          vendor: { select: { businessNameEn: true, slug: true } },
          country: { select: { nameEn: true, currencyCode: true } },
          category: { select: { nameEn: true } },
          city: { select: { nameEn: true } },
          _count: { select: { bookings: true, reviews: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.activity.count({ where }),
    ]);

    return { data: activities, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateActivityStatus(
    activityId: string,
    status: any,
    adminUserId: string,
    reason?: string,
  ) {
    const db = this.prisma.client;

    // Step 1: flip the activity status. Doing this BEFORE the cascade ensures
    // no new bookings can be created while we refund the existing ones (catalog
    // filters status=ACTIVE; booking creation re-checks status at create time).
    const activity = await db.activity.update({
      where: { id: activityId },
      data: { status },
      select: { id: true, titleEn: true, status: true, vendor: { select: { userId: true } } },
    });

    // Step 2: vendor-facing approval/rejection notification (existing behaviour).
    const activityTypeMap: Record<string, 'ACTIVITY_APPROVED' | 'ACTIVITY_REJECTED'> = {
      ACTIVE: 'ACTIVITY_APPROVED',
      BLOCKED: 'ACTIVITY_REJECTED',
    };
    if (activityTypeMap[status] && activity.vendor) {
      this.notificationService.send({
        userId: activity.vendor.userId,
        type: activityTypeMap[status],
        title: status === 'ACTIVE' ? 'Activity Approved' : 'Activity Rejected',
        message: `Your activity "${activity.titleEn}" has been ${status === 'ACTIVE' ? 'approved and is now live' : 'rejected by admin'}`,
      });
    }

    // Step 3: when deactivating or blocking, cascade-cancel every future
    // PENDING/CONFIRMED booking and refund the customer. Without this, paid
    // customers would keep the booking record but the event would never happen
    // and no money would return.
    let cascadeResult: { cancelled: number; failed: number } | undefined;
    if (status === 'INACTIVE' || status === 'BLOCKED') {
      cascadeResult = await this.cascadeCancelFutureBookings(
        activityId,
        activity.titleEn,
        adminUserId,
        status,
        reason,
      );
    }

    return {
      ...activity,
      ...(cascadeResult
        ? {
            cancelledBookings: cascadeResult.cancelled,
            ...(cascadeResult.failed > 0
              ? { failedCancellations: cascadeResult.failed }
              : {}),
          }
        : {}),
    };
  }

  // ─── Activity availability blocks (admin can manage ANY activity's locks) ──
  // Reuses the same shared core as the vendor flow, so validation can't drift.
  // No vendor-ownership scoping (admin is platform-wide); blocks are stamped
  // with the activity's owning vendorId.
  async getActivityBlocks(activityId: string) {
    const db = this.prisma.client;
    const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true } });
    if (!activity) throw new NotFoundException('Activity not found');
    return db.activityBlock.findMany({
      where: { activityId, deletedAt: null },
      orderBy: { blockStart: 'asc' },
      select: { id: true, blockStart: true, blockEnd: true, createdAt: true },
    });
  }

  async createActivityBlock(activityId: string, dto: CreateActivityBlockDto) {
    const db = this.prisma.client;
    const activity = await db.activity.findUnique({
      where: { id: activityId },
      select: { id: true, vendorId: true, bookingType: true, checkInTime: true, checkOutTime: true, durationValue: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');
    const result = await createActivityBlockCore(db, activity, dto);
    void this.availabilityCache.invalidate(activityId);
    return result;
  }

  async deleteActivityBlock(activityId: string, blockId: string) {
    const db = this.prisma.client;
    const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true } });
    if (!activity) throw new NotFoundException('Activity not found');
    const res = await db.activityBlock.updateMany({
      where: { id: blockId, activityId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Block not found');
    void this.availabilityCache.invalidate(activityId);
    return { id: blockId, removed: true };
  }

  async deleteActivityBlocksBulk(activityId: string, ids: string[]) {
    const db = this.prisma.client;
    const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true } });
    if (!activity) throw new NotFoundException('Activity not found');
    const res = await db.activityBlock.updateMany({
      where: { id: { in: ids }, activityId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count > 0) void this.availabilityCache.invalidate(activityId);
    return { removed: res.count };
  }

  // ─── Special prices (per-date price overrides; admin = any activity) ──
  async getActivitySpecialPrices(activityId: string) {
    const db = this.prisma.client;
    const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true } });
    if (!activity) throw new NotFoundException('Activity not found');
    // Only current/future overrides — past dates can't be booked and the
    // calendar shows [today, +6mo]. Also bounds the result: old overrides are
    // never hard-deleted, so without a floor this query would grow over time.
    const todayUtc = new Date(new Date().toISOString().slice(0, 10));
    return db.activitySpecialPrice.findMany({
      where: { activityId, deletedAt: null, date: { gte: todayUtc } },
      orderBy: { date: 'asc' },
      select: { id: true, date: true, price: true, createdAt: true },
    });
  }

  async createActivitySpecialPrice(activityId: string, dto: CreateSpecialPriceDto) {
    const db = this.prisma.client;
    const activity = await db.activity.findUnique({
      where: { id: activityId },
      select: { id: true, vendorId: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');
    const result = await createSpecialPriceCore(db, activity, dto);
    void this.availabilityCache.invalidate(activityId);
    return result;
  }

  async bulkCreateActivitySpecialPrices(activityId: string, dto: BulkSpecialPriceDto) {
    const db = this.prisma.client;
    const activity = await db.activity.findUnique({
      where: { id: activityId },
      select: { id: true, vendorId: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');
    const result = await db.$transaction(
      (tx: any) => bulkCreateSpecialPricesCore(tx, activity, dto),
      { timeout: 20000 },
    );
    void this.availabilityCache.invalidate(activityId);
    return result;
  }

  async deleteActivitySpecialPrice(activityId: string, priceId: string) {
    const db = this.prisma.client;
    const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true } });
    if (!activity) throw new NotFoundException('Activity not found');
    const res = await db.activitySpecialPrice.updateMany({
      where: { id: priceId, activityId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Special price not found');
    void this.availabilityCache.invalidate(activityId);
    return { id: priceId, removed: true };
  }

  /**
   * Cascade-cancel every future PENDING/CONFIRMED booking for an activity
   * that was just deactivated or blocked. Each booking runs in its own
   * transaction with an optimistic-lock `updateMany` so concurrent writes
   * (customer cancel, payment callback) can't double-refund. Failures are
   * counted and logged per booking without aborting the whole batch — admin
   * can re-run by toggling status if anything got stuck.
   *
   * DoS guard: capped at CASCADE_MAX bookings per invocation.
   * Rate limit: enforced by the caller endpoint (RATE_LIMIT_WRITE).
   */
  private async cascadeCancelFutureBookings(
    activityId: string,
    activityTitle: string,
    adminUserId: string,
    reason: 'INACTIVE' | 'BLOCKED',
    adminReason?: string,
  ): Promise<{ cancelled: number; failed: number }> {
    const db = this.prisma.client;
    const CASCADE_MAX = 1000;

    // Only cancel bookings that have NOT yet started. startDatetime is local-
    // wall-clock tagged-UTC, so "started" must be judged in the activity's OWN
    // timezone — a raw `gte: new Date()` would treat an in-progress booking (up
    // to the country's +offset, ~3h GCC) as "future" and cancel + 100% refund a
    // customer who is currently attending. This is a single activity, so it has
    // exactly one timezone (no multi-tz aggregate concern). nowInTimezone('UTC')
    // === raw now, so UTC-country activities are unchanged.
    const act = await db.activity.findUnique({
      where: { id: activityId },
      select: { country: { select: { defaultTimezone: true } } },
    });
    const activityTz = act?.country?.defaultTimezone ?? 'UTC';

    const bookings = await db.booking.findMany({
      where: {
        activityId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startDatetime: { gte: nowInTimezone(activityTz) },
      },
      select: {
        id: true,
        ref: true,
        customerId: true,
        pointsRedeemed: true,
        couponCode: true,
        payment: { select: { id: true, status: true, amount: true } },
      },
      take: CASCADE_MAX,
    });

    if (bookings.length === 0) return { cancelled: 0, failed: 0 };

    // Load loyalty config ONCE — qarPerPoint is platform-level, doesn't change
    // during the batch. Avoids re-querying per booking.
    let loyaltyConfig = await db.loyaltyConfig.findUnique({ where: { id: 'singleton' } });
    if (!loyaltyConfig) {
      loyaltyConfig = await db.loyaltyConfig.create({ data: { id: 'singleton' } });
    }
    const qarPerPoint = loyaltyConfig.qarPerPoint.toNumber();

    const reasonText = reason === 'BLOCKED' ? 'blocked' : 'deactivated';
    // adminReason is already sanitized by the global SanitizePipe + DTO MaxLength(1000).
    // We only ever store it, never render it back into notifications (customer-facing
    // text uses the activity title + a fixed template), which rules out any
    // reflected-XSS path even if sanitisation were ever bypassed.
    const refundNote = adminReason
      ? `Activity ${reasonText} by admin: ${adminReason.slice(0, 500)}`
      : `Activity ${reasonText} by admin`;

    let cancelled = 0;
    let failed = 0;

    for (const bk of bookings) {
      try {
        const wasPaid = bk.payment?.status === 'SUCCESS';
        await db.$transaction(async (tx: any) => {
          // Optimistic lock: only act if still cancellable. Prevents double-
          // refund if the customer cancelled concurrently or the cron already
          // expired a PENDING reservation.
          const upd = await tx.booking.updateMany({
            where: { id: bk.id, status: { in: ['PENDING', 'CONFIRMED'] } },
            data: {
              status: 'CANCELLED',
              cancelledAt: new Date(),
              cancelledBy: 'ADMIN',
              refundDecisionAt: new Date(),
              refundDecisionBy: adminUserId,
              refundDecisionActor: 'ADMIN',
              refundDecisionNote: refundNote,
            },
          });
          if (upd.count === 0) return; // Raced out — nothing to refund.

          if (bk.payment) {
            if (bk.payment.status === 'SUCCESS') {
              const paidAmount = Number(bk.payment.amount);
              await tx.payment.update({
                where: { id: bk.payment.id },
                data: {
                  status: 'REFUNDED',
                  refundAmount: paidAmount,
                  refundedAt: new Date(),
                },
              });
              const refundPoints =
                qarPerPoint > 0 ? Math.round((paidAmount / qarPerPoint) * 100) / 100 : 0;
              if (refundPoints > 0) {
                await this.loyalty.refund(tx, {
                  userId: bk.customerId,
                  amount: refundPoints,
                  bookingId: bk.id,
                  source: 'ADMIN_REFUND_APPROVED',
                  actorType: 'ADMIN',
                  actorId: adminUserId,
                  note: `Cascade ${reasonText}: ${paidAmount} refund → ${refundPoints} points, booking ${bk.ref}`,
                });
              }
            } else if (bk.payment.status === 'PENDING') {
                            // Optimistic lock, NOT a plain update. The `status === 'PENDING'`
              // above was read earlier; a PAY2M capture can commit in between and
              // flip the row to SUCCESS. An unguarded update would force that
              // captured payment back to FAILED while the booking is cancelled,
              // leaving the customer charged with no REFUND_PENDING row —
              // recordRefundDecision requires REFUND_PENDING, so the refund queue
              // could never reach it. Same incident the customer-cancel path was
              // fixed for; this path was missed.
              const flipped = await tx.payment.updateMany({
                where: { id: bk.payment.id, status: 'PENDING' },
                data: { status: 'FAILED' },
              });
              if (flipped.count === 0) {
                // State-neutral on purpose: a zero-row update does NOT prove a
                // capture completed. A PAY2M failure callback or the
                // stale-PENDING cleanup cron can flip the row out of PENDING
                // first, and in those cases the booking may be gone entirely.
                // Naming only the capture case would tell an admin the booking
                // is paid when it is not.
                throw new ConflictException(
                  'This booking changed while you were cancelling. Please refresh to see its current state.',
                );
              }
            }
          }

          const redeemed = Number(bk.pointsRedeemed) || 0;
          if (redeemed > 0) {
            await this.loyalty.refund(tx, {
              userId: bk.customerId,
              amount: redeemed,
              bookingId: bk.id,
              source: 'CANCEL_REFUND_PAID',
              actorType: 'ADMIN',
              actorId: adminUserId,
              note: `Returned redeemed points on cascade cancel for booking ${bk.ref}`,
            });
          }

          await refundCouponUsage(tx, bk.couponCode, bk.customerId);
        });

        cancelled++;

        // Customer notification — fire-and-forget. NotificationService has its
        // own try/catch; pipeline failure never rolls back the refund.
        const refundLine = wasPaid
          ? ' Your payment has been refunded as Wanasa points to your balance.'
          : '';
        this.notificationService.send({
          userId: bk.customerId,
          type: 'BOOKING_CANCELLED',
          title: 'Your booking was cancelled',
          message: `"${activityTitle}" was ${reasonText} by AL Jadwal support, and your booking ${bk.ref} has been cancelled.${refundLine}`,
          link: `/bookings/${bk.id}`,
        });
      } catch (err: unknown) {
        // Log class name + business ID only — never the raw message. Admin
        // can retry the batch by toggling status again; optimistic-lock on
        // booking.status makes the retry safe.
        const kind = err instanceof Error ? err.name : 'UnknownError';
        this.logger.error(`Cascade cancel failed for booking ${bk.id} (${kind})`);
        failed++;
      }
    }

    // ── Resolve orphaned pending refunds ──────────────────────────────────
    // The loop above only touches bookings still PENDING/CONFIRMED. A booking
    // the CUSTOMER already cancelled sits in REFUND_PENDING awaiting a vendor/
    // admin decision (the cancellation-policy step). If the activity is THEN
    // blocked/deactivated, that decision may never come and the refund is
    // stranded — payment stuck at REFUND_PENDING, 0 Wanasa points credited,
    // while the customer was told the refund was issued. Blocking/deactivating
    // an activity is an unambiguous platform-side cancellation, so auto-approve
    // those pending refunds at 100% → Wanasa points (same conversion + ledger
    // path as a manual refund decision). Idempotent: the REFUND_PENDING
    // optimistic lock means a concurrent/duplicate run is a no-op, so an admin
    // can safely re-toggle the status to retry.
    const orphanedPending = await db.booking.findMany({
      where: {
        activityId,
        status: 'CANCELLED',
        payment: { is: { status: 'REFUND_PENDING' } },
      },
      select: {
        id: true,
        ref: true,
        customerId: true,
        payment: { select: { id: true, amount: true } },
      },
      take: CASCADE_MAX,
    });

    let resolvedPending = 0;
    for (const bk of orphanedPending) {
      if (!bk.payment) continue;
      try {
        const paidAmount = Number(bk.payment.amount);
        const refundPoints = qarPerPoint > 0 ? Math.round((paidAmount / qarPerPoint) * 100) / 100 : 0;
        const committed = await db.$transaction(async (tx: any) => {
          // Optimistic lock — only the first writer flips REFUND_PENDING.
          const upd = await tx.payment.updateMany({
            where: { id: bk.payment!.id, status: 'REFUND_PENDING' },
            data: { status: 'REFUNDED', refundAmount: paidAmount, refundedAt: new Date() },
          });
          if (upd.count === 0) return false; // already decided concurrently
          await tx.booking.update({
            where: { id: bk.id },
            data: {
              refundDecisionAt: new Date(),
              refundDecisionBy: adminUserId,
              refundDecisionActor: 'ADMIN',
              refundDecisionNote: refundNote,
            },
          });
          if (refundPoints > 0) {
            await this.loyalty.refund(tx, {
              userId: bk.customerId,
              amount: refundPoints,
              bookingId: bk.id,
              source: 'ADMIN_REFUND_APPROVED',
              actorType: 'ADMIN',
              actorId: adminUserId,
              note: `Auto-approved pending refund on activity ${reasonText}: ${paidAmount} → ${refundPoints} points, booking ${bk.ref}`,
            });
          }
          return true;
        });
        if (!committed) continue;
        resolvedPending++;
        // Fire-and-forget — never roll back the refund on a notification error.
        this.notificationService.send({
          userId: bk.customerId,
          type: 'BOOKING_CANCELLED',
          title: 'Your refund was approved',
          message:
            refundPoints > 0
              ? `Your pending refund for booking ${bk.ref} was approved — ${refundPoints} Wanasa points have been added to your balance.`
              : `Your pending refund for booking ${bk.ref} has been processed.`,
          link: `/bookings/${bk.id}`,
        });
      } catch (err: unknown) {
        const kind = err instanceof Error ? err.name : 'UnknownError';
        this.logger.error(`Orphan refund resolve failed for booking ${bk.id} (${kind})`);
        failed++;
      }
    }

    if (resolvedPending > 0) {
      this.logger.log(
        `Cascade ${reasonText}: auto-approved ${resolvedPending} orphaned pending refund(s) for activity ${activityId}`,
      );
    }

    if (cancelled > 0) {
      void this.availabilityCache.invalidate(activityId);
    }

    return { cancelled, failed };
  }

  async toggleFeatured(activityId: string) {
    const activity = await this.prisma.client.activity.findUnique({
      where: { id: activityId },
      select: { id: true, isFeatured: true, titleEn: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');

    return this.prisma.client.activity.update({
      where: { id: activityId },
      data: { isFeatured: !activity.isFeatured },
      select: { id: true, titleEn: true, isFeatured: true },
    });
  }

  // ─── Bookings ───────────────────────────────────────────────
  async getBookings(query: PaginationDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search, status, paymentStatus } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.BookingWhereInput = {};
    if (search) {
      where.OR = [
        { ref: { contains: search, mode: 'insensitive' } },
        { customer: { fullName: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status) {
      where.status = status as any;
    }
    if (paymentStatus) {
      // Used by the refund queue to narrow to REFUND_PENDING only.
      where.payment = { status: paymentStatus as any };
    }

    const [bookings, total] = await Promise.all([
      db.booking.findMany({
        where,
        select: {
          id: true, ref: true, guests: true, bookingPhone: true, totalPrice: true, serviceFee: true,
          commissionPct: true, commissionAmount: true, couponCode: true, couponDiscount: true,
          // Loyalty redemption — surfaces Wanasa points used. Without these,
          // a points-funded booking renders as QAR 0 with no indication of the
          // actual activity cost or how it was paid.
          pointsRedeemed: true, pointsDiscount: true,
          currencyCode: true, selectedExtras: true, startDatetime: true, endDatetime: true,
          status: true, createdAt: true,
          // Cancellation + refund audit fields (null for non-cancelled bookings)
          cancelledAt: true, cancelledBy: true,
          refundDecisionAt: true, refundDecisionBy: true, refundDecisionActor: true, refundDecisionNote: true,
          customer: { select: { id: true, fullName: true, email: true, phone: true } },
          // bookingType + durationValue surface the actual booked time range
          // (now flex-length for HOURLY) in the admin table, so support can
          // see at a glance whether a booking is 2h or 8h.
          activity: { select: { titleEn: true, bookingType: true, durationValue: true, cancellationPolicy: true, country: { select: { currencyCode: true } } } },
          vendor: { select: { businessNameEn: true } },
          payment: { select: { id: true, amount: true, status: true, method: true, paidAt: true, gatewayTxnId: true, refundAmount: true, refundedAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.booking.count({ where }),
    ]);

    return { data: bookings, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateBookingStatus(adminUserId: string, bookingId: string, status: string) {
    const db = this.prisma.client;
    const booking = await db.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, ref: true, activityId: true, customerId: true, status: true, totalPrice: true,
        pointsRedeemed: true, pointsDiscount: true, pointsAwarded: true, couponCode: true,
        activity: { select: { titleEn: true } },
        payment: { select: { id: true, status: true, amount: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Reject CONFIRMED transitions when no successful payment exists.
    // Without this guard, an admin (or compromised admin JWT) could
    // PATCH any PENDING booking to CONFIRMED — vendor sees a paid
    // reservation, customer never paid, platform/vendor lose revenue
    // with no audit signal beyond the generic UPDATE_BOOKING_STATUS
    // entry. The full-points (WANASA_POINTS) path also satisfies this
    // because that synthetic payment is created with status=SUCCESS.
    if (status === 'CONFIRMED' && booking.payment?.status !== 'SUCCESS') {
      throw new BadRequestException(
        'Cannot confirm a booking without a successful payment',
      );
    }

    let cancelledNow = false;
    // Captured when a cancel refunds a booking whose vendor payout was already
    // PAID — surfaced to admins after commit so the vendor's share can be
    // recovered manually (we do NOT auto-claw it back).
    let clawbackNeeded: { amount: number; paymentId: string; ref: string } | null = null;
    const updated = await db.$transaction(async (tx: any) => {
      // Admin-initiated cancel stamps cancelledAt/By for history. Admin does
      // NOT go through the refund queue — admin is final arbiter and refund
      // is recorded immediately at 100%. Handles edge cases like suspended
      // vendors who can't log in to process their own queue.
      //
      // CANCELLED is the money-mutating transition. Claim it optimistically so
      // exactly ONE concurrent cancel (double-click / two tabs / retried
      // request) wins — otherwise the refund + loyalty-credit block below runs
      // twice and the customer is credited their refund points twice. Mirrors
      // the customer cancelBooking guard (bookings.service.ts). CONFIRMED /
      // COMPLETED keep the plain update (they have their own guards).
      if (status === 'CANCELLED') {
        const claim = await tx.booking.updateMany({
          where: { id: bookingId, status: { not: 'CANCELLED' } },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: 'ADMIN',
            refundDecisionAt: new Date(),
            refundDecisionBy: adminUserId,
            refundDecisionActor: 'ADMIN',
          },
        });
        if (claim.count === 0) {
          // Lost the race — already cancelled by a concurrent request. Do NOT
          // re-run any refund; just return the current row.
          return tx.booking.findUniqueOrThrow({
            where: { id: bookingId },
            include: {
              customer: { select: { fullName: true } },
              activity: { select: { titleEn: true } },
            },
          });
        }
        cancelledNow = true;
      }

      const result =
        status === 'CANCELLED'
          ? await tx.booking.findUniqueOrThrow({
              where: { id: bookingId },
              // Fresh in-tx snapshot AFTER winning the claim — the refund /
              // reversal logic below reads payment status, pointsRedeemed and
              // pointsAwarded from THIS row, never the pre-tx `booking` read, so
              // a concurrent payment callback or completion can't drive a stale
              // refund or a missed/incorrect reversal.
              include: {
                customer: { select: { fullName: true } },
                activity: { select: { titleEn: true } },
                payment: { select: { id: true, status: true, amount: true, payoutStatus: true } },
              },
            })
          : await tx.booking.update({
              where: { id: bookingId },
              data: { status: status as any },
              include: {
                customer: { select: { fullName: true } },
                activity: { select: { titleEn: true } },
              },
            });

      // Handle payment state when admin cancels a paid booking.
      // Refund goes to Wanasa points (store credit), NOT back to card.
      if (status === 'CANCELLED' && result.payment) {
        if (result.payment.status === 'SUCCESS') {
          const paidAmount = Number(result.payment.amount);
          await tx.payment.update({
            where: { id: result.payment.id },
            data: {
              status: 'REFUNDED',
              refundAmount: paidAmount,
              refundedAt: new Date(),
            },
          });

          // Flag for manual clawback if the vendor was ALREADY paid out for this
          // booking — refunding the customer now leaves the platform out that
          // money twice. We don't auto-reverse the payout; surface it post-commit.
          if (result.payment.payoutStatus === 'PAID') {
            clawbackNeeded = { amount: paidAmount, paymentId: result.payment.id, ref: result.ref };
          }

          // Convert full refund to Wanasa points — routed through LoyaltyService
          // so the ledger records ADMIN_REFUND_APPROVED.
          let loyaltyConfig = await tx.loyaltyConfig.findUnique({ where: { id: 'singleton' } });
          if (!loyaltyConfig) loyaltyConfig = await tx.loyaltyConfig.create({ data: { id: 'singleton' } });
          const qarPerPoint = loyaltyConfig.qarPerPoint.toNumber();
          const refundPoints = qarPerPoint > 0 ? Math.round((paidAmount / qarPerPoint) * 100) / 100 : 0;
          if (refundPoints > 0) {
            await this.loyalty.refund(tx, {
              userId: result.customerId,
              amount: refundPoints,
              bookingId,
              source: 'ADMIN_REFUND_APPROVED',
              actorType: 'ADMIN',
              actorId: null,
              note: `Admin cancel: ${paidAmount} refund → ${refundPoints} points, booking ${result.ref}`,
            });
          }
        } else if (result.payment.status === 'PENDING') {
                    // Optimistic lock, NOT a plain update. The `status === 'PENDING'`
          // above was read earlier; a PAY2M capture can commit in between and
          // flip the row to SUCCESS. An unguarded update would force that
          // captured payment back to FAILED while the booking is cancelled,
          // leaving the customer charged with no REFUND_PENDING row —
          // recordRefundDecision requires REFUND_PENDING, so the refund queue
          // could never reach it. Same incident the customer-cancel path was
          // fixed for; this path was missed.
          const flipped = await tx.payment.updateMany({
            where: { id: result.payment.id, status: 'PENDING' },
            data: { status: 'FAILED' },
          });
          if (flipped.count === 0) {
            throw new ConflictException(
              'This booking changed while you were cancelling. Please refresh to see its current state.',
            );
          }
        }

        // Refund redeemed loyalty points back to customer (separate from refund-to-points above)
        const redeemedPoints = Number(result.pointsRedeemed) || 0;
        if (redeemedPoints > 0) {
          await this.loyalty.refund(tx, {
            userId: result.customerId,
            amount: redeemedPoints,
            bookingId,
            source: 'CANCEL_REFUND_PAID',
            actorType: 'ADMIN',
            actorId: null,
            note: `Admin cancel returned redeemed points on booking ${result.ref}`,
          });
        }

        // Reverse points that were AWARDED on a COMPLETED booking that the
        // admin is now cancelling. Without this, the customer keeps the
        // earned points (8+ QAR per 100 in store credit) plus gets a
        // cash refund — repeatable double-dip exploit. Computed using the
        // same earn-rate formula (LoyaltyService.computeEarnedPoints) so reversal mirrors
        // exactly what was credited. Idempotent — `pointsAwarded` is
        // flipped to false alongside the debit so re-cancel attempts (which
        // shouldn't happen because of the double-cancel guard, but defence
        // in depth) don't double-reverse.
        if (result.pointsAwarded === true) {
          // Reverse the EXACT points credited on this booking (its BOOKING_EARN
          // ledger row), NOT a recompute with the CURRENT earn rate — an admin
          // rate change between award and cancel would otherwise debit the wrong
          // amount (or 0, leaving free residual points). 0 → nothing to reverse
          // (points-paid booking earned 0). pointsAwarded → false so a re-cancel
          // can't double-reverse.
          const awardedPoints = await this.loyalty.getEarnedPoints(tx, bookingId);
          if (awardedPoints > 0) {
            await this.loyalty.reverseAwarded(tx, {
              userId: result.customerId,
              amount: awardedPoints,
              bookingId,
              actorType: 'ADMIN',
              actorId: null,
              note: `Admin cancel of COMPLETED booking ${result.ref} — debiting ${awardedPoints} previously-awarded points`,
            });
            await tx.booking.update({
              where: { id: bookingId },
              data: { pointsAwarded: false },
            });
          }
        }
      }

      // Coupon refund when admin cancels — regardless of payment status so
      // the customer's voucher / usage count is restored.
      if (status === 'CANCELLED') {
        await refundCouponUsage(tx, result.couponCode, result.customerId);
      }

      // Award loyalty points when booking becomes COMPLETED
      if (status === 'COMPLETED' && !booking.pointsAwarded) {
        let config = await tx.loyaltyConfig.findUnique({ where: { id: 'singleton' } });
        if (!config) {
          config = await tx.loyaltyConfig.create({ data: { id: 'singleton' } });
        }
        const points = this.loyalty.computeEarnedPoints(
          Number(booking.totalPrice),
          Number(booking.pointsDiscount),
          config.pointsPerQar.toNumber(),
        );
        if (points > 0) {
          // Atomically CLAIM the award: flip pointsAwarded false→true only if it
          // is still false, so two concurrent completes can't both earn. (See the
          // matching guard in vendor.service.ts — status→COMPLETED above is not a
          // claim, and the stale pre-tx check let both through.)
          const claim = await tx.booking.updateMany({
            where: { id: bookingId, pointsAwarded: false },
            data: { pointsAwarded: true },
          });
          if (claim.count === 1) {
            await this.loyalty.earn(tx, {
              userId: booking.customerId,
              amount: points,
              bookingId,
              note: `Earned on booking ${booking.ref} (${Number(booking.totalPrice)})`,
            });
            // Notify customer (fire-and-forget, after transaction)
            this.notificationService.send({
              userId: booking.customerId,
              type: 'SYSTEM' as any,
              title: 'Points Earned!',
              message: `You earned ${points} WANASA points for booking ${booking.ref}`,
              link: '/bookings',
            });
          }
        }
      }

      return result;
    });

    // CANCELLED is the only transition that frees capacity. Other transitions
    // (CONFIRMED, COMPLETED) keep the booking blocking the slot.
    if (status === 'CANCELLED' && cancelledNow) {
      void this.availabilityCache.invalidate(booking.activityId);

      // Customer notification — admin action, customer didn't initiate.
      // Activity title is from DB, not user input. NotificationService
      // handles its own errors — fire-and-forget keeps the cancel atomic.
      const wasPaid = booking.payment?.status === 'SUCCESS';
      const refundLine = wasPaid
        ? ' Your payment has been refunded as Wanasa points to your balance.'
        : '';
      this.notificationService.send({
        userId: booking.customerId,
        type: 'BOOKING_CANCELLED',
        title: 'Your booking was cancelled',
        message: `Booking ${booking.ref} for "${booking.activity.titleEn}" was cancelled by AL Jadwal support.${refundLine}`,
        link: `/bookings/${bookingId}`,
      });

      // Cancel-after-payout: the vendor was already paid for this booking, so the
      // customer refund leaves the platform out-of-pocket. Flag for MANUAL
      // recovery (policy: no auto-clawback) — alert admins + a durable log.
      // clawbackNeeded is assigned inside the $transaction closure above; TS's
      // control-flow can't see closure mutations, so re-widen via an explicit cast.
      const clawback = clawbackNeeded as { amount: number; paymentId: string; ref: string } | null;
      if (clawback) {
        this.logger.warn({
          event: 'PAYOUT_CLAWBACK_NEEDED',
          paymentId: clawback.paymentId,
          bookingRef: clawback.ref,
          amount: clawback.amount,
        });
        this.notificationService.notifyAdmins({
          type: 'SYSTEM',
          title: 'Payout clawback needed',
          message: `Booking ${clawback.ref} was cancelled and refunded, but its vendor payout was already PAID (${clawback.amount}). Recover the vendor's share manually.`,
          link: '/admin/payouts',
        });
      }
    }

    return updated;
  }

  // ─── Payouts ──────────────────────────────────────────────
  async getPayouts(query: PaginationDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search } = query;
    const skip = (page - 1) * limit;

    // ── This list means "what is PAYABLE NOW", not "every successful payment" ──
    //
    // A vendor is only paid once their activity has actually happened. Showing
    // future bookings here offered money the platform must not release yet: the
    // customer can still cancel before the activity starts, and a payout already
    // sent would leave the platform out of pocket with no clawback path.
    //
    // The escrow rule is enforced again in markPayoutsPaid, but enforcement
    // alone is not enough — if the list still OFFERS in-escrow rows, "select
    // all" trips the guard and the whole batch is refused, so nothing settles
    // and the admin has no way to tell which rows to deselect. Filtering here
    // makes the mistake unofferable; the guard downstream becomes a backstop
    // that should never fire in normal use.
    //
    // Side effect, deliberate: a payment whose booking row is gone (a B2 orphan
    // awaiting recovery) no longer appears. It has no vendor and no payable
    // share, so it was never actionable — the reconciliation cron owns it.
    const payoutBufferDays = Math.max(0, envNumber('PAYOUT_SETTLEMENT_BUFFER_DAYS', 0));
    const payoutCutoff = new Date(Date.now() - payoutBufferDays * 86_400_000);

    const bookingFilter: Prisma.BookingWhereInput = { endDatetime: { lt: payoutCutoff } };
    if (search) {
      bookingFilter.OR = [
        { ref: { contains: search, mode: 'insensitive' } },
        { vendor: { businessNameEn: { contains: search, mode: 'insensitive' } } },
        { customer: { fullName: { contains: search, mode: 'insensitive' } } },
        { activity: { titleEn: { contains: search, mode: 'insensitive' } } },
      ];
    }
    const where: Prisma.PaymentWhereInput = { status: 'SUCCESS', booking: bookingFilter };

    const [payments, total] = await Promise.all([
      db.payment.findMany({
        where,
        include: {
          booking: {
            include: {
              vendor: { select: { id: true, businessNameEn: true } },
              customer: { select: { fullName: true } },
              activity: { select: { titleEn: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.payment.count({ where }),
    ]);

    // Decorate each row with a flag telling the UI whether the vendor has a
    // non-terminal payout request covering this payment. When true, bulk
    // mark-as-paid is blocked — admin must resolve the request via the
    // Payout Requests page first (approve + complete, or reject).
    //
    // Two conditions make a payment "locked":
    //   1. Vendor has a PENDING request: that request implicitly claims ALL
    //      of the vendor's SUCCESS+UNPAID payments (paymentIds are not
    //      locked until APPROVE), so we block the whole vendor.
    //   2. Vendor has an APPROVED/COMPLETED request whose paymentIds array
    //      includes this specific payment. APPROVED must go through the
    //      Complete flow to stay consistent with the request record.
    const vendorIds = Array.from(
      new Set(payments.map((p) => p.booking?.vendor?.id).filter(Boolean) as string[]),
    );
    const inflightRequests = vendorIds.length > 0
      ? await db.payoutRequest.findMany({
          where: { vendorId: { in: vendorIds }, status: { in: ['PENDING', 'APPROVED'] } },
          select: { id: true, vendorId: true, status: true, paymentIds: true },
        })
      : [];
    const pendingVendorIds = new Set(
      inflightRequests.filter((r) => r.status === 'PENDING').map((r) => r.vendorId),
    );
    const lockedPaymentIds = new Set(
      inflightRequests
        .filter((r) => r.status === 'APPROVED')
        .flatMap((r) => r.paymentIds ?? []),
    );
    const enriched = payments.map((p) => {
      const vendorId = p.booking?.vendor?.id;
      const inflightRequest = vendorId && pendingVendorIds.has(vendorId)
        ? { status: 'PENDING' as const }
        : lockedPaymentIds.has(p.id)
        ? { status: 'APPROVED' as const }
        : null;
      return { ...p, inflightRequest };
    });

    // ── Upcoming (in escrow) — visible, but not payable ─────────────────────
    // Filtering the list to payable-only would otherwise make future money
    // vanish entirely: a vendor asks "where is my payout?" and the admin sees
    // nothing at all, with no way to tell "not earned yet" from "we lost it".
    // Surface the count and the earliest date it becomes payable, WITHOUT
    // making any of it selectable. Counts only UNPAID rows — an already-PAID
    // future booking (possible on rows settled before the escrow rule existed)
    // is not upcoming money.
    const upcomingWhere: Prisma.PaymentWhereInput = {
      status: 'SUCCESS',
      payoutStatus: 'UNPAID',
      booking: { endDatetime: { gte: payoutCutoff } },
    };
    const [upcomingCount, nextPayable] = await Promise.all([
      db.payment.count({ where: upcomingWhere }),
      db.payment.findFirst({
        where: upcomingWhere,
        select: { booking: { select: { endDatetime: true } } },
        orderBy: { booking: { endDatetime: 'asc' } },
      }),
    ]);

    return {
      data: enriched,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      // `total` counts payable rows only. These two describe money that exists
      // but is still in escrow, so the UI can say "12 bookings become payable
      // from 20 Aug" instead of silently showing nothing.
      upcomingCount,
      upcomingFrom: nextPayable?.booking?.endDatetime ?? null,
    };
  }

  // ─── Countries CRUD ─────────────────────────────────────────
  async getCountries(query: PaginationDto = {}) {
    // Bounded list — admin reference data table grows slowly (GCC = ~6 rows
    // today). Default 20 / max 100 from PaginationDto caps the blast radius
    // if the table ever balloons; clients pass ?limit=100 to fetch all.
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return this.prisma.client.country.findMany({
      where: { deletedAt: null }, // hide soft-deleted countries (Bug C)
      include: { _count: { select: { cities: true, vendors: true, activities: true } } },
      // Stable pagination: id as secondary key breaks ties on nameEn so
      // a page-1+page-2 fetch can't double-return or skip rows.
      orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
      take: limit,
      skip: (page - 1) * limit,
    });
  }

  async createCountry(dto: CreateCountryDto) {
    const result = await this.prisma.client.country.create({ data: dto });
    // C1 cache: fire-and-forget — cache failure must NEVER fail the write.
    void this.refCache.invalidate('countries');
    return result;
  }

  async updateCountry(id: string, dto: UpdateCountryDto) {
    const result = await this.prisma.client.country.update({ where: { id }, data: dto });
    void this.refCache.invalidate('countries');
    return result;
  }

  async deleteCountry(id: string) {
    const db = this.prisma.client;
    const country = await db.country.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!country) throw new NotFoundException('Country not found');

    // Bug C — count only LIVE (non-soft-deleted) vendors/activities. Vendor &
    // activity "delete" is itself a soft-delete (the row + its countryId are
    // kept for the 7-year audit window), so the old check (which counted ALL
    // rows) meant a country could never be deleted once any vendor/activity had
    // ever existed there. Only genuinely-active dependencies should block it.
    const [liveVendors, liveActivities] = await Promise.all([
      db.vendor.count({ where: { countryId: id, deletedAt: null } }),
      db.activity.count({ where: { countryId: id, deletedAt: null } }),
    ]);
    if (liveVendors > 0 || liveActivities > 0) {
      throw new ForbiddenException('Cannot delete a country that still has active vendors or activities. Remove them first.');
    }

    // Soft-delete (NOT hard-delete): keep the row + its cities so soft-deleted
    // vendors/activities that still reference countryId retain their audit
    // linkage and the FK never dangles. A non-null deletedAt removes the country
    // from every admin/public list (see getCountries + catalog + geo filters).
    const result = await db.country.update({ where: { id }, data: { deletedAt: new Date() } });
    void this.refCache.invalidate('countries');
    void this.refCache.invalidate('cities');
    return result;
  }

  // ─── Categories CRUD ────────────────────────────────────────
  async getCategories(query: PaginationDto = {}) {
    // Same bounded-list pattern as getCountries. Default 20 / max 100.
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return this.prisma.client.category.findMany({
      include: {
        parent: { select: { nameEn: true } },
        _count: { select: { activities: true, children: true } },
      },
      // Stable pagination — id as tie-breaker on nameEn.
      orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
      take: limit,
      skip: (page - 1) * limit,
    });
  }

  async createCategory(dto: CreateCategoryDto) {
    const result = await this.prisma.client.category.create({ data: dto });
    void this.refCache.invalidate('categories');
    return result;
  }

  async updateCategory(id: string, dto: UpdateCategoryDto) {
    const result = await this.prisma.client.category.update({ where: { id }, data: dto });
    void this.refCache.invalidate('categories');
    return result;
  }

  async deleteCategory(id: string) {
    const category = await this.prisma.client.category.findUnique({
      where: { id },
      include: { _count: { select: { activities: true, children: true } } },
    });
    if (!category) throw new NotFoundException('Category not found');
    if (category._count.activities > 0 || category._count.children > 0) {
      throw new NotFoundException('Cannot delete category with activities or subcategories');
    }
    const result = await this.prisma.client.category.delete({ where: { id } });
    void this.refCache.invalidate('categories');
    return result;
  }

  // ─── Cities CRUD ────────────────────────────────────────────
  async getCities() {
    return this.prisma.client.city.findMany({
      include: {
        country: { select: { nameEn: true, isoCode: true } },
        _count: { select: { activities: true } },
      },
      orderBy: { nameEn: 'asc' },
    });
  }

  async createCity(dto: CreateCityDto) {
    const result = await this.prisma.client.city.create({
      data: dto,
      include: { country: { select: { nameEn: true, isoCode: true } } },
    });
    void this.refCache.invalidate('cities');
    return result;
  }

  async updateCity(id: string, dto: UpdateCityDto) {
    const result = await this.prisma.client.city.update({
      where: { id },
      data: dto,
      include: { country: { select: { nameEn: true, isoCode: true } } },
    });
    void this.refCache.invalidate('cities');
    return result;
  }

  async deleteCity(id: string) {
    const city = await this.prisma.client.city.findUnique({
      where: { id },
      include: { _count: { select: { activities: true } } },
    });
    if (!city) throw new NotFoundException('City not found');
    if (city._count.activities > 0) {
      throw new NotFoundException('Cannot delete city with activities');
    }
    const result = await this.prisma.client.city.delete({ where: { id } });
    void this.refCache.invalidate('cities');
    return result;
  }

  // ─── Coupons ────────────────────────────────────────────────
  async getCoupons(query: PaginationDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search, status } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.CouponWhereInput = {};
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { vendor: { businessNameEn: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status) {
      where.status = status as any;
    }

    const [coupons, total] = await Promise.all([
      db.coupon.findMany({
        where,
        include: { vendor: { select: { businessNameEn: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.coupon.count({ where }),
    ]);

    return { data: coupons, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createCoupon(dto: CreateCouponDto) {
    // Percentage coupons must not exceed 100
    if (dto.discountType === 'PERCENTAGE' && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100%');
    }
    // Normalise the validity window to whole-day UTC bounds — start-of-day for
    // validFrom, END-of-day for validTo — so a coupon "valid to <date>" stays
    // usable through that entire day. The /offers + checkout queries filter
    // `validTo > now`; a bare-midnight validTo expired the coupon at 00:00 of
    // the expiry day, so it never showed (the reported "coupon not showing").
    const validFrom = new Date(`${String(dto.validFrom).slice(0, 10)}T00:00:00.000Z`);
    const validTo = new Date(`${String(dto.validTo).slice(0, 10)}T23:59:59.999Z`);
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) {
      throw new BadRequestException('Invalid validity dates');
    }
    if (validTo <= validFrom) {
      throw new BadRequestException('Expiry date must be after the start date');
    }
    // Check for duplicate code
    const existing = await this.prisma.client.coupon.findUnique({ where: { code: dto.code.toUpperCase() } });
    if (existing) throw new BadRequestException('A coupon with this code already exists');

    return this.prisma.client.coupon.create({
      data: {
        code: dto.code.toUpperCase(),
        // Activity scoping (Bug A): empty = applies to all. Admin/platform
        // coupons may scope to any activity (no vendor-ownership restriction).
        applicableActivityIds: dto.activityIds ?? [],
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        validFrom,
        validTo,
        usageLimit: dto.usageLimit ?? null,
        minOrderAmount: dto.minOrderAmount ?? null,
        maxDiscount: dto.maxDiscount ?? null,
        status: 'APPROVED',
      },
      include: { vendor: { select: { businessNameEn: true } } },
    });
  }

  async updateCouponStatus(id: string, status: string) {
    const coupon = await this.prisma.client.coupon.update({
      where: { id },
      data: { status: status as any },
      select: { id: true, code: true, status: true, vendorId: true, vendor: { select: { userId: true } } },
    });

    // Notify vendor about coupon status
    if (coupon.vendor && (status === 'APPROVED' || status === 'REJECTED')) {
      this.notificationService.send({
        userId: coupon.vendor.userId,
        type: status === 'APPROVED' ? 'COUPON_APPROVED' : 'COUPON_REJECTED',
        title: status === 'APPROVED' ? 'Coupon Approved' : 'Coupon Rejected',
        message: `Your coupon "${coupon.code}" has been ${status.toLowerCase()} by admin`,
      });
    }

    return coupon;
  }

  async deleteCoupon(id: string) {
    return this.prisma.client.coupon.delete({ where: { id } });
  }

  // ─── Platform Settings (Commission + Platform Info) ─────────
  async getPlatformSettings() {
    let settings = await this.prisma.client.platformSettings.findUnique({
      where: { id: 'default' },
    });
    if (!settings) {
      settings = await this.prisma.client.platformSettings.create({
        data: { id: 'default', defaultCommissionPct: 10 },
      });
    }
    return settings;
  }

  async updatePlatformSettings(dto: UpdatePlatformSettingsDto) {
    const result = await this.prisma.client.platformSettings.upsert({
      where: { id: 'default' },
      update: dto,
      create: { id: 'default', defaultCommissionPct: dto.defaultCommissionPct ?? 10, ...dto },
    });
    void this.refCache.invalidate('platform-info');
    return result;
  }

  // kept for backward compat
  async getCommissionSettings() {
    return this.getPlatformSettings();
  }

  async updateCommissionSettings(defaultCommissionPct: number) {
    return this.updatePlatformSettings({ defaultCommissionPct });
  }

  // ─── Trending Events CRUD ──────────────────────────────────
  async getTrendingEvents(query: PaginationDto = {}) {
    // Same bounded-list pattern. Default 20 / max 100.
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return this.prisma.client.trendingEvent.findMany({
      // Stable pagination — id as tie-breaker on createdAt.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: (page - 1) * limit,
    });
  }

  async createTrendingEvent(dto: CreateTrendingEventDto) {
    return this.prisma.client.trendingEvent.create({ data: dto });
  }

  async updateTrendingEvent(id: string, dto: UpdateTrendingEventDto) {
    return this.prisma.client.trendingEvent.update({ where: { id }, data: dto });
  }

  async deleteTrendingEvent(id: string) {
    return this.prisma.client.trendingEvent.delete({ where: { id } });
  }

  // ─── Reviews Moderation ─────────────────────────────────────
  async getReviews(query: PaginationDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.ReviewWhereInput = {};
    if (search) {
      where.OR = [
        { text: { contains: search, mode: 'insensitive' } },
        { customer: { fullName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [reviews, total] = await Promise.all([
      db.review.findMany({
        where,
        include: {
          customer: { select: { fullName: true, email: true } },
          activity: { select: { titleEn: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.review.count({ where }),
    ]);

    return { data: reviews, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async deleteReview(id: string) {
    return this.prisma.client.review.delete({ where: { id } });
  }

  // ─── Activity Single + Edit by Admin ───────────────────────────
  async getActivity(id: string) {
    const activity = await this.prisma.client.activity.findUnique({
      where: { id },
      include: {
        vendor: { select: { businessNameEn: true, slug: true, countryId: true } },
        country: { select: { id: true, nameEn: true, currencyCode: true } },
        category: { select: { id: true, nameEn: true, parentId: true } },
        city: { select: { id: true, nameEn: true } },
      },
    });
    if (!activity) throw new NotFoundException('Activity not found');
    return activity;
  }

  async updateActivity(id: string, dto: UpdateActivityDto) {
    const activity = await this.prisma.client.activity.findUnique({ where: { id } });
    if (!activity) throw new NotFoundException('Activity not found');

    // HOURLY time config must remain internally consistent (duration ≤ window).
    // Merge DTO values with existing values so partial PATCHes still validate.
    assertHourlyTimesConsistent(
      {
        bookingType: dto.bookingType ?? activity.bookingType,
        checkInTime: dto.checkInTime ?? activity.checkInTime,
        checkOutTime: dto.checkOutTime ?? activity.checkOutTime,
        durationValue: dto.durationValue ?? activity.durationValue,
      },
      // Grid-check only the times THIS update sets — a legacy off-grid activity
      // must stay editable on unrelated fields (window check still uses merged).
      { checkIn: dto.checkInTime !== undefined, checkOut: dto.checkOutTime !== undefined },
    );

    const { categoryId, subCategoryId, cityId, ...rest } = dto;
    const data: any = { ...rest };
    if (categoryId) data.category = { connect: { id: categoryId } };
    if (subCategoryId !== undefined) data.subCategoryId = subCategoryId || null;
    if (cityId) data.city = { connect: { id: cityId } };

    return this.prisma.client.activity.update({
      where: { id },
      data,
      include: {
        vendor: { select: { businessNameEn: true } },
        category: { select: { id: true, nameEn: true } },
        country: { select: { nameEn: true, currencyCode: true } },
        city: { select: { id: true, nameEn: true } },
      },
    });
  }

  // ─── Payout Processing ────────────────────────────────────────
  async markPayoutsPaid(paymentIds: string[], bankTransferRef: string) {
    const db = this.prisma.client;

    // Block bulk-mark-paid for any payment whose vendor has an in-flight
    // payout request (PENDING or APPROVED). Those flows own the payment's
    // lifecycle until admin resolves them on the Payout Requests page;
    // side-flipping here would desync the request record from the payment
    // state. We collect every blocker so the error message names the
    // vendors involved instead of only the first one admin hits.
    const paymentsWithVendor = await db.payment.findMany({
      where: { id: { in: paymentIds } },
      select: {
        id: true,
        booking: {
          select: {
            vendor: { select: { id: true, businessNameEn: true, status: true } },
          },
        },
      },
    });

    // §M3 — suspended-vendor guard. If any payment in the batch belongs
    // to a non-ACTIVE vendor, block the whole batch. Vendor was likely
    // suspended for fraud or compliance reasons since the request was
    // approved; transferring money to them now would defeat the
    // suspension. Admin must reactivate (or process refunds) before
    // marking these paid.
    const suspendedVendors = new Set<string>();
    for (const p of paymentsWithVendor) {
      const v = p.booking?.vendor;
      if (v && v.status !== 'ACTIVE') {
        suspendedVendors.add(`${v.businessNameEn} (${v.status})`);
      }
    }
    if (suspendedVendors.size > 0) {
      const names = Array.from(suspendedVendors).slice(0, 3).join(', ');
      const tail = suspendedVendors.size > 3 ? ` and ${suspendedVendors.size - 3} more` : '';
      throw new BadRequestException(
        `${names}${tail} ${suspendedVendors.size === 1 ? 'is' : 'are'} not currently ACTIVE. Reactivate the vendor (or refund the payments) before marking these paid.`,
      );
    }
    const vendorIds = Array.from(
      new Set(paymentsWithVendor.map((p) => p.booking?.vendor?.id).filter(Boolean) as string[]),
    );
    const blockers = vendorIds.length > 0
      ? await db.payoutRequest.findMany({
          where: { vendorId: { in: vendorIds }, status: { in: ['PENDING', 'APPROVED'] } },
          select: { vendorId: true, status: true, paymentIds: true, vendor: { select: { businessNameEn: true } } },
        })
      : [];
    // Determine which of the submitted payments are actually locked. A
    // PENDING request blocks the whole vendor; an APPROVED request blocks
    // only its locked paymentIds set.
    const pendingVendorIds = new Set(blockers.filter((r) => r.status === 'PENDING').map((r) => r.vendorId));
    const approvedLockedIds = new Set(
      blockers.filter((r) => r.status === 'APPROVED').flatMap((r) => r.paymentIds ?? []),
    );
    const offendingVendors = new Set<string>();
    for (const p of paymentsWithVendor) {
      const vId = p.booking?.vendor?.id;
      if (vId && pendingVendorIds.has(vId)) {
        offendingVendors.add(p.booking!.vendor!.businessNameEn);
      } else if (approvedLockedIds.has(p.id)) {
        const vName = p.booking?.vendor?.businessNameEn;
        if (vName) offendingVendors.add(vName);
      }
    }
    if (offendingVendors.size > 0) {
      const names = Array.from(offendingVendors).slice(0, 3).join(', ');
      const tail = offendingVendors.size > 3 ? ` and ${offendingVendors.size - 3} more` : '';
      throw new BadRequestException(
        `${names}${tail} ${offendingVendors.size === 1 ? 'has' : 'have'} an in-flight payout request. Approve or reject on the Payout Requests page first — don't bulk-mark these individually.`,
      );
    }

    // §M4 — capture the bank-transfer reference number alongside the
    // payoutStatus flip so any future dispute / forensic audit can link a
    // system-PAID row to a real bank transaction. The DTO marks
    // bankTransferRef as required; this runtime guard is a belt-and-braces
    // check so a bypassed validator can't slip a NULL into prod.
    const trimmedRef = (bankTransferRef ?? '').trim();
    if (!trimmedRef) {
      throw new BadRequestException('bankTransferRef is required — record the bank-side wire confirmation number before marking paid.');
    }

    // Escrow buffer — MUST mirror evaluatePayoutEligibility and the
    // approve-payout path (both filter `booking.endDatetime < payoutCutoff`).
    // This release path used to omit it, so a payment could be marked PAID
    // while its activity was still in the future. The customer could then
    // cancel before start (cancelBooking only blocks AFTER start) and the
    // refund would be approved with no awareness that the vendor had already
    // been paid — money out twice, with no clawback and no alert anywhere.
    // Filtering here means an ineligible row is simply not marked, and the
    // count check below surfaces the discrepancy to the caller.
    const payoutBufferDays = Math.max(0, envNumber('PAYOUT_SETTLEMENT_BUFFER_DAYS', 0));
    const payoutCutoff = new Date(Date.now() - payoutBufferDays * 86_400_000);

    // ── Pre-validate BEFORE writing anything ────────────────────────────────
    // Marking paid is the system's record that a bank wire ALREADY LEFT
    // (bankTransferRef is mandatory above). If some rows silently fail to
    // match, the admin has wired money the DB still considers UNPAID — those
    // rows resurface in the next payout cycle and get wired a SECOND time.
    // The UI cannot save us here: payments-tab.tsx discards the return value
    // and toasts success unconditionally.
    //
    // So refuse the whole batch and name the offenders instead of settling a
    // subset. Nothing is written, and the admin can correct the selection
    // before (or after) the wire rather than discovering a double-payment on
    // a bank statement.
    // Scope the rejection to ESCROW only, deliberately.
    //
    // Rows in a genuinely invalid state (REFUNDED / REJECTED / REFUND_PENDING,
    // or already PAID) are still skipped silently — that is the existing,
    // tested contract, and it is safe because the payouts list only ever
    // offers `status: SUCCESS, payoutStatus: UNPAID` rows, so an admin cannot
    // select them from the UI. Skipping there is defence-in-depth against a
    // crafted API call, not something a human will act on.
    //
    // Escrow is different: those rows ARE offered by the list (it does not
    // filter on endDatetime), they look completely normal, and marking paid
    // records a bank wire that has ALREADY LEFT. Silently skipping them leaves
    // them UNPAID, so they resurface next cycle and get wired a SECOND time —
    // and payments-tab.tsx discards the return value and toasts success
    // regardless. So refuse the batch and name them.
    const inEscrow = await db.payment.findMany({
      where: {
        id: { in: paymentIds },
        status: 'SUCCESS',
        payoutStatus: 'UNPAID',
        booking: { endDatetime: { gte: payoutCutoff } },
      },
      select: { id: true },
    });
    if (inEscrow.length > 0) {
      const ids = inEscrow.map((p) => p.id);
      this.logger.warn({
        event: 'PAYOUT_MARK_PAID_REJECTED_ESCROW',
        requested: paymentIds.length,
        inEscrow: ids.length,
      });
      // The message must describe the ACTUAL cutoff. With
      // PAYOUT_SETTLEMENT_BUFFER_DAYS=3 an activity that ended two days ago is
      // still in escrow, so "has not ended yet" would be plainly false and
      // send the admin looking for a problem that isn't there.
      const bufferNote = payoutBufferDays > 0
        ? `their activity has not yet cleared the ${payoutBufferDays}-day settlement buffer`
        : 'their activity has not ended yet';
      const retryNote = payoutBufferDays > 0
        ? `Retry once ${payoutBufferDays} day(s) have passed since the activity ended.`
        : 'Retry once the activities have ended.';
      throw new BadRequestException(
        `${ids.length} of ${paymentIds.length} selected payment(s) are still in payout escrow — ` +
          `${bufferNote}. No payments were changed. Paying these out now risks ` +
          'the customer cancelling before the activity starts and being refunded while the vendor ' +
          `already holds the money. ${retryNote} Payment ids: ${ids.slice(0, 10).join(', ')}` +
          (ids.length > 10 ? ` (+${ids.length - 10} more)` : ''),
      );
    }

    // `payoutStatus: 'UNPAID'` in the where makes this a one-way transition:
    // a row already marked PAID is skipped, so a concurrent / repeated call
    // can't overwrite its original `paidAt` + `bankTransferRef`. The same
    // predicate is repeated here (not just relied on from the check above)
    // because a concurrent mark-paid could land between the two statements.
    // updateManyAndReturn (Postgres) so we keep the IDs this invocation actually
    // transitioned. `bankTransferRef` alone cannot identify them: on a mixed
    // retry the same reference is already stamped on rows settled by an EARLIER
    // call, and notifying on that set tells a vendor "payout sent" a second
    // time for money they were already told about.
    const settledNow = await db.payment.updateManyAndReturn({
      where: {
        id: { in: paymentIds },
        status: 'SUCCESS',
        payoutStatus: 'UNPAID',
        booking: { endDatetime: { lt: payoutCutoff } },
      },
      data: { payoutStatus: 'PAID', paidAt: new Date(), bankTransferRef: trimmedRef },
      select: { id: true },
    });
    const result = { count: settledNow.length };

    // Lost the race against a concurrent mark-paid between the check and the
    // write. Surface it — the count is what the caller acts on.
    // Idempotency: distinguish "already settled by this same wire" from a real
    // short write. An ALB timeout after commit makes the admin re-click, and
    // duplicate ids can arrive in one array. In both cases the escrow probe
    // passes (nothing is UNPAID+in-escrow) and updateMany matches 0 rows —
    // which naively reads as "we lost rows" and would page finance about a
    // no-op AND tell every vendor "payout sent" a second time.
    // NOTE: this probe runs AFTER the updateMany above, so the rows that update
    // just flipped are themselves PAID with this bankTransferRef and are counted
    // here. That makes it the COMPLETE total settled under this reference — do
    // NOT add result.count to it. Doing so double-counts the freshly-written
    // rows (1 + 1 >= 2 for a two-id batch where only one settled) and silently
    // suppresses the alert below on a real short write.
    const settledByThisWire = await db.payment.count({
      where: { id: { in: paymentIds }, payoutStatus: 'PAID', bankTransferRef: trimmedRef },
    });
    // Dedupe: a repeated id is one payment, not a missing one.
    const requestedCount = new Set(paymentIds).size;
    if (settledByThisWire < requestedCount) {
      // The bank transfer has ALREADY been sent (bankTransferRef is required
      // above), so a short write is money out with no matching PAID row.
      // Causes are wider than a concurrent mark-paid: a cancellation or refund
      // landing between the escrow probe and this update also flips a row out
      // of SUCCESS/UNPAID. Either way it needs a human, not a debug line —
      // this is the same class of exposure as REFUND_ON_PAID_OUT_BOOKING.
      this.logger.error({
        event: 'PAYOUT_MARK_PAID_PARTIAL',
        requested: requestedCount,
        marked: result.count,
        settledByThisWire,
        unmarked: requestedCount - settledByThisWire,
        bankTransferRef: trimmedRef,
        reason: 'rows changed between the eligibility probe and the write (concurrent mark-paid, cancellation, or refund)',
      });
      this.notificationService.notifyAdmins({
        type: 'SYSTEM',
        title: 'Payout partially recorded — reconcile manually',
        message: `A bank transfer (${trimmedRef}) covered ${requestedCount} payment(s) but only ${settledByThisWire} are PAID against it. The remaining ${requestedCount - settledByThisWire} changed state mid-operation and must be reconciled by hand.`,
        link: '/admin/payouts',
      });
    }

    // Notify each vendor whose payments were marked as paid. Pull the slug
    // here too so the notification link resolves to a real route (the vendor
    // portal lives under /vendor/[slug]/*, not /vendor/*).
    // Only notify when this call actually settled something. On an idempotent
    // retry result.count is 0 — the vendors were already told on the first
    // call, and telling them again reads as a second payout.
    if (result.count === 0) {
      return { updated: 0 };
    }

    // Look up ONLY the rows this call transitioned (ids captured above), not
    // everything submitted and not everything sharing the reference. Notifying
    // on the submitted list would tell a vendor "your payout has been sent" for
    // payments that were skipped — escrow, already-paid, or state-changed.
    // Notifying on the bankTransferRef set would re-notify vendors settled by
    // an earlier attempt of the same wire.
    const payments = await this.prisma.client.payment.findMany({
      where: { id: { in: settledNow.map((p) => p.id) } },
      select: { booking: { select: { vendorId: true, vendor: { select: { userId: true, slug: true } } } } },
    });
    const notifiedVendors = new Set<string>();
    for (const p of payments) {
      const vendorUserId = p.booking?.vendor?.userId;
      const vendorSlug = p.booking?.vendor?.slug;
      if (vendorUserId && vendorSlug && !notifiedVendors.has(vendorUserId)) {
        notifiedVendors.add(vendorUserId);
        this.notificationService.send({
          userId: vendorUserId,
          type: 'PAYOUT_PROCESSED',
          title: 'Payout Processed',
          message: 'Your payout has been processed and sent to your bank account',
          link: `/vendor/${vendorSlug}/earnings`,
        });
      }
    }

    return { updated: result.count };
  }

  /**
   * Reverts a single payment from PAID → UNPAID. Admin escape hatch for the
   * "clicked Mark Paid by mistake" scenario.
   *
   * Safety contract:
   *   1. Payment must exist, be SUCCESS, and currently PAID — otherwise
   *      there's nothing meaningful to revert.
   *   2. Payment must NOT be locked inside an APPROVED or COMPLETED
   *      PayoutRequest. Those requests treat the payment as "already
   *      settled" and flipping it back would desync the vendor's earnings
   *      page. If the admin truly wants to undo a completed request, that
   *      goes through a different workflow.
   *   3. Reason is mandatory (enforced at the DTO) so the audit log has a
   *      human-readable explanation for why cash that was "done" reopened.
   *   4. Admin is notified via the audit interceptor (route mapping above).
   *   5. Vendor is notified so they aren't blindsided by their pending
   *      balance going up again on their next earnings load.
   */
  async markPayoutUnpaid(paymentId: string, adminUserId: string) {
    const db = this.prisma.client;

    const payment = await db.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true, status: true, payoutStatus: true, amount: true,
        booking: {
          select: {
            ref: true,
            vendor: { select: { id: true, userId: true, slug: true, businessNameEn: true } },
          },
        },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'SUCCESS') {
      throw new BadRequestException('Only SUCCESS payments can be reverted');
    }
    if (payment.payoutStatus !== 'PAID') {
      throw new BadRequestException(`Payment is already ${payment.payoutStatus ?? 'UNPAID'} — nothing to revert`);
    }

    // If this payment is locked in a formal payout request (admin already
    // approved/completed a request that includes it), reverting here would
    // leave the request record saying "paid" while the payment says "owed."
    // Block — admin must revert via the payout-requests workflow instead.
    const lockingRequest = await db.payoutRequest.findFirst({
      where: {
        status: { in: ['APPROVED', 'COMPLETED'] },
        paymentIds: { has: paymentId },
      },
      select: { id: true, status: true },
    });
    if (lockingRequest) {
      throw new BadRequestException(
        `This payment is linked to a ${lockingRequest.status.toLowerCase()} payout request. Revert the request from the Payout Requests page instead.`,
      );
    }

    // Optimistic update — only flip if still PAID. Guards against a race
    // where another admin reverts or a new request completes in parallel.
    const result = await db.payment.updateMany({
      where: { id: paymentId, status: 'SUCCESS', payoutStatus: 'PAID' },
      data: { payoutStatus: 'UNPAID', paidAt: null },
    });
    if (result.count === 0) {
      throw new BadRequestException('Payment state changed concurrently. Please refresh and try again.');
    }

    // Explicit audit row — the AdminAuditInterceptor already captures the
    // HTTP body (a tamper-evident record of exactly what was submitted);
    // this companion row captures the BUSINESS impact (booking, vendor,
    // amount) in structured JSON so the finance team can reconcile without
    // cross-referencing the bookings table. Load the admin's real name so
    // the audit trail names the person, not a placeholder.
    const admin = await db.user.findUnique({
      where: { id: adminUserId },
      select: { fullName: true },
    });
    await db.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: adminUserId,
        actorName: admin?.fullName || `admin:${adminUserId.slice(0, 8)}`,
        action: 'REVERT_PAYOUT_TO_UNPAID',
        entity: 'Payment',
        entityId: paymentId,
        details: JSON.stringify({
          bookingRef: payment.booking?.ref ?? null,
          vendorId: payment.booking?.vendor?.id ?? null,
          vendorName: payment.booking?.vendor?.businessNameEn ?? null,
          amount: Number(payment.amount),
          // Fixed system-stamped motive. Admin confirmed in the UI they're
          // reverting a mistaken Mark-Paid; no free-form reason needed.
          reason: 'Reverted mistaken payout marking',
        }),
      },
    });

    // Notify vendor so they see the reversal on their earnings page
    // instead of being confused when their transferred balance drops.
    // Link is slug-scoped because vendor routes live under /vendor/[slug]/*
    // — a slug-less /vendor/earnings 404s.
    const vendorUserId = payment.booking?.vendor?.userId;
    const vendorSlug = payment.booking?.vendor?.slug;
    if (vendorUserId && vendorSlug) {
      this.notificationService.send({
        userId: vendorUserId,
        type: 'SYSTEM' as any,
        title: 'Payout reversed',
        message: `Admin reverted the payout for booking ${payment.booking?.ref ?? ''}. It will reappear in your pending balance for re-processing.`,
        link: `/vendor/${vendorSlug}/earnings`,
      });
    }

    return { reverted: true, paymentId };
  }

  async exportPayouts(query: ExportPaginationDto = {}) {
    // Export endpoint — higher pagination ceiling (1000 default, 5000 max
    // per ExportPaginationDto). Admin reporting needs thousands of rows in
    // one fetch, but still bounded so a runaway query can't pin the DB.
    const page = query.page ?? 1;
    const limit = query.limit ?? 1_000;
    return this.prisma.client.payment.findMany({
      where: { status: 'SUCCESS' },
      include: {
        booking: {
          include: {
            vendor: { select: { businessNameEn: true } },
            customer: { select: { fullName: true } },
            activity: { select: { titleEn: true } },
          },
        },
      },
      // Stable pagination — id as tie-breaker on createdAt so successful
      // payments made in the same second don't shuffle between pages.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: (page - 1) * limit,
    });
  }

  // ─── Payout Requests ──────────────────────────────────────────
  async getPayoutRequests(query: PaginationDto) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, status, search } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.PayoutRequestWhereInput = {};
    if (status) where.status = status as any;
    if (search) {
      // Case-insensitive match on either language of the vendor's business
      // name. `search` is already run through SanitizePipe upstream so no
      // extra escaping is needed here.
      where.vendor = {
        is: {
          OR: [
            { businessNameEn: { contains: search, mode: 'insensitive' } },
            { businessNameAr: { contains: search, mode: 'insensitive' } },
          ],
        },
      };
    }

    const [requests, total] = await Promise.all([
      db.payoutRequest.findMany({
        where,
        include: {
          vendor: {
            select: {
              id: true,
              businessNameEn: true,
              businessNameAr: true,
              slug: true,
              // Only the high-level bank NAME flows to the UI so admin can
              // tell at a glance which bank this vendor is with. Full IBAN +
              // account name are deliberately NOT exposed here to avoid
              // banking-credential leakage via screenshots / screen shares /
              // over-the-shoulder views of the request queue. If admin needs
              // to verify the exact destination before wiring, they open the
              // vendor's settings page (separate nav + future audit log).
              bankDetails: true,
              country: { select: { currencyCode: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.payoutRequest.count({ where }),
    ]);

    // Sanitise each row's vendor.bankDetails before returning: replace the
    // raw JSON blob with { hasBankDetails: boolean, bankName?: string }.
    // Keeps the "has bank details" UX check working without leaking IBAN
    // or account-holder name to the listing endpoint.
    const sanitised = requests.map((r: any) => {
      const raw = r.vendor?.bankDetails as { iban?: string; accountName?: string; bankName?: string } | null | undefined;
      if (!r.vendor) return r;
      return {
        ...r,
        vendor: {
          ...r.vendor,
          bankDetails: raw
            ? { hasBankDetails: true, bankName: raw.bankName ?? null }
            : { hasBankDetails: false, bankName: null },
        },
      };
    });

    return { data: sanitised, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async processPayoutRequest(requestId: string, action: 'APPROVED' | 'REJECTED' | 'COMPLETED', adminNote?: string) {
    const db = this.prisma.client;
    const request = await db.payoutRequest.findUnique({
      where: { id: requestId },
      include: { vendor: { select: { userId: true, slug: true, businessNameEn: true } } },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    // Enforce valid status transitions
    const validTransitions: Record<string, string[]> = {
      PENDING: ['APPROVED', 'REJECTED'],
      APPROVED: ['COMPLETED'],
    };
    const allowed = validTransitions[request.status] ?? [];
    if (!allowed.includes(action)) {
      throw new BadRequestException(`Cannot ${action.toLowerCase()} a ${request.status.toLowerCase()} request`);
    }

    // ─── PENDING → APPROVED: recompute, cap, LOCK specific payments ──
    //
    // The PayoutRequest.amount is a SNAPSHOT taken at request time. Between
    // request and admin approval, a customer can cancel a booking that was
    // part of the snapshot and receive a refund (as Wanasa points — the cash
    // stays with the platform as future point-liability float). If admin
    // approves the stale snapshot amount, the platform double-pays: once as
    // points to the customer, again as cash to the vendor.
    //
    // Safety contract at APPROVE:
    //   - Recompute live eligibility (payment.status=SUCCESS + payoutStatus=
    //     UNPAID — excludes REFUND_PENDING, REFUNDED, REJECTED, FAILED)
    //   - Cap request.amount to the live figure; auto-note the adjustment
    //   - PERSIST the specific payment IDs into PayoutRequest.paymentIds so
    //     the completion step has a deterministic set to mark as PAID
    //   - DO NOT flip payoutStatus yet — money has not physically moved.
    //     Flipping here would make the vendor's "Paid Out" card jump up
    //     before admin actually wires the cash, which is misleading UX.
    //
    // The locked paymentIds also prevent double-claim: requestPayout
    // excludes bookings whose payments are already tied to any non-rejected
    // PayoutRequest.
    if (action === 'APPROVED' && request.status === 'PENDING') {
      const updated = await db.$transaction(async (tx) => {
        // Escrow buffer — mirror evaluatePayoutEligibility: only settle bookings
        // whose activity has ENDED (+ optional PAYOUT_SETTLEMENT_BUFFER_DAYS), so
        // the FIFO lock (ordered by payment.createdAt, which does NOT track the
        // activity date) can't tie up a still-cancellable future booking.
        const payoutBufferDays = Math.max(0, envNumber('PAYOUT_SETTLEMENT_BUFFER_DAYS', 0));
        const payoutCutoff = new Date(Date.now() - payoutBufferDays * 86_400_000);
        const eligible = await tx.payment.findMany({
          where: {
            status: 'SUCCESS',
            payoutStatus: 'UNPAID',
            booking: { vendorId: request.vendorId, endDatetime: { lt: payoutCutoff } },
          },
          select: {
            id: true,
            booking: { select: { totalPrice: true, commissionAmount: true } },
          },
          // FIFO: oldest payments first. Ensures vendor is paid out for
          // their earliest-earned bookings first if eligible > requested.
          orderBy: { createdAt: 'asc' },
        });

        // Greedy accumulate vendor's share until we reach request.amount.
        // Any eligible payment beyond that stays UNPAID for a future request.
        const requestedAmount = Number(request.amount);
        const paymentsToLock: string[] = [];
        let accumulated = 0;
        for (const p of eligible) {
          if (!p.booking) continue;
          const vendorShare =
            Number(p.booking.totalPrice) - Number(p.booking.commissionAmount);
          if (vendorShare <= 0) continue; // Wanasa-only bookings: nothing to pay out
          if (accumulated >= requestedAmount) break;
          // Round to 2dp to match the schema Decimal(10,2)
          accumulated = Math.round((accumulated + vendorShare) * 100) / 100;
          paymentsToLock.push(p.id);
        }

        if (accumulated <= 0) {
          throw new BadRequestException(
            'No eligible payments remain for this request — the underlying bookings have been refunded since the request was submitted. Reject the request; the vendor can file a fresh one if anything is still payable.',
          );
        }

        const finalAmount = Math.min(requestedAmount, accumulated);
        const wasAdjusted = finalAmount < requestedAmount;
        const baseNote = adminNote?.trim() ?? '';
        const adjustmentNote = `[System: amount auto-adjusted from ${requestedAmount.toFixed(2)} to ${finalAmount.toFixed(2)} — bookings were refunded after this request was submitted]`;
        const finalNote = wasAdjusted
          ? (baseNote ? `${baseNote}\n${adjustmentNote}` : adjustmentNote)
          : (baseNote || null);

        // Optimistic lock on status=PENDING catches concurrent approves.
        const statusUpdate = await tx.payoutRequest.updateMany({
          where: { id: requestId, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            amount: finalAmount,
            adminNote: finalNote,
            paymentIds: paymentsToLock,
            processedAt: new Date(),
          },
        });
        if (statusUpdate.count === 0) {
          throw new ConflictException('This request was already processed by another admin');
        }

        return tx.payoutRequest.findUniqueOrThrow({ where: { id: requestId } });
      });

      // Notify vendor: approved but transfer still in-flight.
      this.notificationService.send({
        userId: request.vendor.userId,
        type: 'PAYOUT_PROCESSED',
        title: 'Payout approved',
        message: `Your payout of ${Number(updated.amount).toFixed(2)} ${updated.currency} has been approved. Funds will reflect after the bank transfer completes.`,
        link: `/vendor/${request.vendor.slug}/earnings`,
      });

      return updated;
    }

    // ─── APPROVED → COMPLETED: release the lock; admin still has to mark paid ──
    //
    // Two-step settlement, split for operational clarity:
    //   1. Completing the REQUEST closes the payout-request workflow (the
    //      vendor stops seeing it in-flight) but does NOT mark the
    //      underlying payments as paid. The request's paymentIds stop
    //      blocking those rows on the Payments tab, so admin can now see
    //      them as actionable.
    //   2. Admin then opens the Payments tab and clicks Mark as Paid on
    //      those now-actionable rows, confirming the bank transfer
    //      actually landed on the vendor's side.
    //
    // Why split? It gives admin a distinct "money has physically moved"
    // checkpoint that's decoupled from the request-management workflow.
    // Completing a request is a promise; marking paid is the receipt.
    //
    // Safety: we still re-verify payments are SUCCESS+UNPAID before
    // closing the request, so a race with markPayoutUnpaid / cascade
    // refunds can't silently settle a request against missing money.
    if (action === 'COMPLETED' && request.status === 'APPROVED') {
      const paymentIds = request.paymentIds ?? [];
      if (paymentIds.length === 0) {
        throw new BadRequestException('This approved request has no locked payments. Contact engineering — data looks inconsistent.');
      }

      // §M2 — pre-flight eligibility check outside the COMPLETED tx. If a
      // parallel markPayoutsPaid or a cascade refund moved any of the
      // locked payments, the previous behaviour aborted with a
      // BadRequestException, leaving the request stuck in APPROVED with
      // no path forward without manual SQL. New behaviour: auto-revert
      // to PENDING with a system note in its OWN tx (so the revert
      // commits even though we throw afterwards), then surface a clear
      // error so admin re-runs eligibility and completes a fresh cycle.
      // Doing the revert in the SAME tx as the throw would roll back
      // the revert — that was the original bug.
      const stillEligible = await db.payment.count({
        where: {
          id: { in: paymentIds },
          status: 'SUCCESS',
          payoutStatus: 'UNPAID',
        },
      });
      if (stillEligible !== paymentIds.length) {
        const drift = paymentIds.length - stillEligible;
        const baseNote = (adminNote ?? request.adminNote ?? '').trim();
        const systemNote = `[System: payments no longer eligible (${drift} of ${paymentIds.length} refunded after approval). Re-evaluate.]`;
        const finalNote = baseNote ? `${baseNote}\n${systemNote}` : systemNote;
        // Optimistic-lock revert in its own tx — commits before we throw.
        const revertCount = await db.payoutRequest.updateMany({
          where: { id: requestId, status: 'APPROVED' },
          data: {
            status: 'PENDING',
            adminNote: finalNote,
            paymentIds: [],            // unlock — eligibility recomputed at next APPROVE
            processedAt: null,
          },
        });
        if (revertCount.count === 0) {
          // Lost a race with another admin; fall through to the standard
          // already-completed message.
          throw new ConflictException('This request was already completed by another admin');
        }
        throw new BadRequestException(
          `Some of the approved payments are no longer eligible (${drift} of ${paymentIds.length} changed state). Request auto-reverted to PENDING — re-approve to pick up the remaining eligible payments.`,
        );
      }

      const updated = await db.$transaction(async (tx) => {
        // Re-verify inside tx for race safety — between pre-flight and now,
        // another flow could have moved one of the payments. The COMPLETE
        // transition must operate on the same set the pre-flight saw.
        const stillEligibleInTx = await tx.payment.count({
          where: {
            id: { in: paymentIds },
            status: 'SUCCESS',
            payoutStatus: 'UNPAID',
          },
        });
        if (stillEligibleInTx !== paymentIds.length) {
          // Lost the race; throw out so the caller retries — the revert
          // path above will catch it next attempt.
          throw new ConflictException(
            'Eligibility changed during completion. Try again — the request will auto-revert if drift persists.',
          );
        }

        // Close the request. Payments stay UNPAID until admin explicitly
        // marks them paid on the Payments tab.
        const statusUpdate = await tx.payoutRequest.updateMany({
          where: { id: requestId, status: 'APPROVED' },
          data: {
            status: 'COMPLETED',
            adminNote: adminNote ?? request.adminNote,
            processedAt: new Date(),
          },
        });
        if (statusUpdate.count === 0) {
          throw new ConflictException('This request was already completed by another admin');
        }

        return tx.payoutRequest.findUniqueOrThrow({ where: { id: requestId } });
      });

      this.notificationService.send({
        userId: request.vendor.userId,
        type: 'PAYOUT_PROCESSED',
        title: 'Payout approved — transfer in progress',
        message: `Your payout of ${Number(updated.amount).toFixed(2)} ${updated.currency} has been approved for transfer. You'll be notified again once the admin confirms the cash has landed.`,
        link: `/vendor/${request.vendor.slug}/earnings`,
      });

      return updated;
    }

    // ─── REJECTED (terminal) or any residual transition ──
    // No money flow, just status + audit note.
    const updated = await db.payoutRequest.update({
      where: { id: requestId },
      data: {
        status: action,
        adminNote: adminNote ?? null,
        processedAt: new Date(),
      },
    });

    // Notify vendor
    this.notificationService.send({
      userId: request.vendor.userId,
      type: 'PAYOUT_PROCESSED',
      title: action === 'REJECTED' ? 'Payout Request Rejected' : 'Payout Processed',
      message: action === 'REJECTED'
        ? `Your payout request was rejected${adminNote ? `: ${adminNote}` : ''}`
        : `Your payout of ${Number(request.amount).toFixed(2)} ${request.currency} has been processed`,
      link: `/vendor/${request.vendor.slug}/earnings`,
    });

    return updated;
  }

  /**
   * Re-opens a closed payout request. Admin escape hatch for every
   * "clicked the wrong button" scenario on the request workflow.
   *
   * Allowed transitions:
   *   APPROVED  → PENDING   — releases paymentIds lock, request re-enters queue
   *   COMPLETED → APPROVED  — reopens for completion; paymentIds stay locked
   *   COMPLETED → PENDING   — full rewind; paymentIds released
   *   REJECTED  → PENDING   — unreject, request re-enters queue
   *
   * Blocked transitions:
   *   REJECTED → APPROVED   — eligibility must be re-checked via the normal
   *                           PENDING → APPROVED path; skipping it would use
   *                           a stale amount snapshot
   *   PENDING  → *          — nothing to revert; admin should Reject instead
   *
   * Safety contract:
   *   1. Transition table is whitelisted — no admin-supplied status string
   *      reaches Prisma.
   *   2. Reverting to PENDING/APPROVED for a vendor that already has an
   *      in-flight request is blocked (breaks the "at most one active
   *      request per vendor" invariant).
   *   3. Optimistic lock on current status guards against parallel reverts.
   *   4. Audit row captures actor, from/to states, and vendor context.
   *   5. Vendor is notified so they're not blindsided by their earnings
   *      page flipping state.
   */
  async revertPayoutRequest(requestId: string, targetStatus: 'PENDING' | 'APPROVED', adminUserId: string) {
    const db = this.prisma.client;

    const request = await db.payoutRequest.findUnique({
      where: { id: requestId },
      include: { vendor: { select: { id: true, userId: true, slug: true, businessNameEn: true } } },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    const allowedTransitions: Record<string, Array<'PENDING' | 'APPROVED'>> = {
      APPROVED: ['PENDING'],
      COMPLETED: ['PENDING', 'APPROVED'],
      REJECTED: ['PENDING'],
    };
    const valid = allowedTransitions[request.status] ?? [];
    if (!valid.includes(targetStatus)) {
      throw new BadRequestException(
        `Cannot revert a ${request.status.toLowerCase()} request to ${targetStatus.toLowerCase()}. Allowed revert targets: ${valid.length > 0 ? valid.map((s) => s.toLowerCase()).join(', ') : '(none)'}.`,
      );
    }

    // Enforce the "at most one in-flight per vendor" invariant. Without this
    // guard, reverting a REJECTED/COMPLETED request to PENDING while the
    // vendor already has a newer PENDING would leave two active requests on
    // the same vendor — downstream approval races would double-lock payments.
    const otherInflight = await db.payoutRequest.findFirst({
      where: {
        vendorId: request.vendorId,
        status: { in: ['PENDING', 'APPROVED'] },
        NOT: { id: requestId },
      },
      select: { id: true, status: true },
    });
    if (otherInflight) {
      throw new BadRequestException(
        `${request.vendor?.businessNameEn ?? 'This vendor'} already has a ${otherInflight.status.toLowerCase()} payout request. Resolve that one before reverting this record.`,
      );
    }

    // Extra safety: when reverting from COMPLETED, re-confirm the locked
    // payments are still SUCCESS+UNPAID. If admin has already marked them
    // paid on the Payments tab (which is legitimate under the two-step
    // flow), reverting would desync the request from the ledger.
    if (request.status === 'COMPLETED' && (request.paymentIds?.length ?? 0) > 0) {
      const stillUnpaid = await db.payment.count({
        where: { id: { in: request.paymentIds }, status: 'SUCCESS', payoutStatus: 'UNPAID' },
      });
      if (stillUnpaid !== request.paymentIds.length) {
        throw new BadRequestException(
          'Some of the payments in this request have already been marked as paid on the Payments tab. Revert those payouts first, then retry.',
        );
      }
    }

    // Optimistic update — only flip if still in the observed source state.
    const updateData: Record<string, unknown> = {
      status: targetStatus,
      // Reverting to PENDING releases any payment lock so the request
      // re-enters the queue with nothing staked. Reverting to APPROVED
      // keeps the existing paymentIds so Complete can be retried.
      ...(targetStatus === 'PENDING' ? { paymentIds: [] } : {}),
      // Clear processedAt when reverting to PENDING so the timeline reads
      // naturally ("not yet processed" again). Keep it for APPROVED —
      // that's still a processed decision, just rolled back one step.
      ...(targetStatus === 'PENDING' ? { processedAt: null } : {}),
    };
    const updateResult = await db.payoutRequest.updateMany({
      where: { id: requestId, status: request.status },
      data: updateData,
    });
    if (updateResult.count === 0) {
      throw new BadRequestException('Request state changed concurrently. Please refresh and try again.');
    }

    const updated = await db.payoutRequest.findUniqueOrThrow({ where: { id: requestId } });

    // Audit with business context baked in — the interceptor also captures
    // the raw body, but this typed row lets the finance team reconcile
    // without cross-referencing by id.
    const admin = await db.user.findUnique({ where: { id: adminUserId }, select: { fullName: true } });
    await db.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: adminUserId,
        actorName: admin?.fullName || `admin:${adminUserId.slice(0, 8)}`,
        action: 'REVERT_PAYOUT_REQUEST',
        entity: 'PayoutRequest',
        entityId: requestId,
        details: JSON.stringify({
          vendorId: request.vendorId,
          vendorName: request.vendor?.businessNameEn ?? null,
          fromStatus: request.status,
          toStatus: targetStatus,
          amount: Number(request.amount),
        }),
      },
    });

    // Notify vendor — their earnings / eligibility state is about to change.
    if (request.vendor?.userId && request.vendor?.slug) {
      this.notificationService.send({
        userId: request.vendor.userId,
        type: 'PAYOUT_PROCESSED',
        title: 'Payout request reopened',
        message: `Admin reverted your payout request (${Number(request.amount).toFixed(2)} ${request.currency}) from ${request.status.toLowerCase()} back to ${targetStatus.toLowerCase()} for review.`,
        link: `/vendor/${request.vendor.slug}/earnings`,
      });
    }

    return updated;
  }

  // ─── Vendor Analytics ─────────────────────────────────────────
  async getVendorAnalytics(vendorId: string) {
    const db = this.prisma.client;
    const [
      revenueByMonth,
      bookingsByStatus,
      reviewStats,
      recentBookings,
    ] = await Promise.all([
      db.booking.groupBy({
        by: ['createdAt'],
        where: { vendorId, status: { in: ['CONFIRMED', 'COMPLETED'] } },
        // pointsDiscount + couponDiscount let the admin view both cash
        // revenue AND nominal bookings value per month. Vendors with heavy
        // Wanasa redemption would otherwise appear to have "zero revenue"
        // months on their admin profile, which misrepresents activity.
        _sum: { totalPrice: true, pointsDiscount: true, couponDiscount: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.booking.groupBy({
        by: ['status'],
        where: { vendorId },
        _count: true,
      }),
      db.review.aggregate({
        where: { activity: { vendorId } },
        _avg: { rating: true },
        _count: true,
      }),
      db.booking.findMany({
        where: { vendorId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          activity: { select: { titleEn: true } },
          customer: { select: { fullName: true } },
        },
      }),
    ]);

    return { revenueByMonth, bookingsByStatus, reviewStats, recentBookings };
  }

  // ─── Audit Logs ───────────────────────────────────────────────
  async createAuditLog(adminId: string, adminName: string, action: string, entity: string, entityId?: string, details?: string) {
    return this.prisma.client.auditLog.create({
      data: { actorType: 'ADMIN', actorId: adminId, actorName: adminName, action, entity, entityId, details },
    });
  }

  async getAuditLogs(query: PaginationDto & { actorType?: string; from?: string; to?: string }) {
    const db = this.prisma.client;
    const { page = 1, limit = 20, search, actorType, from, to } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {};

    // Filter by actor type — validate against enum
    const VALID_ACTOR_TYPES = ['ADMIN', 'VENDOR', 'CUSTOMER', 'SYSTEM'] as const;
    if (actorType && VALID_ACTOR_TYPES.includes(actorType as any)) {
      where.actorType = actorType as (typeof VALID_ACTOR_TYPES)[number];
    }

    // Date range filter — validate date strings before parsing
    if (from || to) {
      const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
      where.createdAt = {};
      if (from && ISO_DATE.test(from)) {
        const d = new Date(from + 'T00:00:00.000Z');
        if (!isNaN(d.getTime())) where.createdAt.gte = d;
      }
      if (to && ISO_DATE.test(to)) {
        const d = new Date(to + 'T23:59:59.999Z');
        if (!isNaN(d.getTime())) where.createdAt.lte = d;
      }
      // If both dates invalid, remove the empty filter
      if (!where.createdAt.gte && !where.createdAt.lte) delete where.createdAt;
    }

    // Search across multiple fields
    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { entity: { contains: search, mode: 'insensitive' } },
        { actorName: { contains: search, mode: 'insensitive' } },
        { details: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.auditLog.count({ where }),
    ]);

    return { data: logs, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Dashboard Charts Data ────────────────────────────────────
  async getDashboardCharts() {
    const db = this.prisma.client;
    const sixMonthsAgo = addMonthsClamped(new Date(), -6);

    const [revenueData, bookingsByCategory, vendorGrowth] = await Promise.all([
      db.payment.findMany({
        where: { status: 'SUCCESS', createdAt: { gte: sixMonthsAgo } },
        select: { amount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.activity.findMany({
        where: { bookings: { some: { status: { not: 'CANCELLED' } } } },
        select: {
          id: true,
          titleEn: true,
          category: { select: { nameEn: true } },
          // Count only non-cancelled bookings so the dashboard matches the
          // per-vendor activity tiles (both intentionally exclude cancels).
          _count: {
            select: { bookings: { where: { status: { not: 'CANCELLED' } } } },
          },
        },
        orderBy: { bookings: { _count: 'desc' } },
        take: 10,
      }),
      db.vendor.findMany({
        where: { createdAt: { gte: sixMonthsAgo } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Aggregate revenue + vendor growth by month. Maps are PRE-PADDED to
    // exactly 6 months ending on the current month so the frontend chart
    // titled "Last 6 months" always has 6 data points — even when only
    // the current month has any activity. Without this, sparse data
    // renders as a single floating dot under the 6-month caption (the
    // contract / UI mismatch fixed on 2026-04-27).
    //
    // Convention: time-bucketed endpoints return DENSE windows. See
    // .antigravity/rules.md §"API contracts — dense time windows".
    const now = new Date();
    const revenueByMonth: Record<string, number> = {};
    const vendorsByMonth: Record<string, number> = {};
    for (let offset = 5; offset >= 0; offset--) {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      revenueByMonth[key] = 0;
      vendorsByMonth[key] = 0;
    }
    for (const p of revenueData) {
      const key = `${p.createdAt.getFullYear()}-${String(p.createdAt.getMonth() + 1).padStart(2, '0')}`;
      if (key in revenueByMonth) revenueByMonth[key] += Number(p.amount);
    }
    for (const v of vendorGrowth) {
      const key = `${v.createdAt.getFullYear()}-${String(v.createdAt.getMonth() + 1).padStart(2, '0')}`;
      if (key in vendorsByMonth) vendorsByMonth[key] += 1;
    }

    // Per-activity cash revenue (vendor share on SUCCESS payments). Done as
    // one groupBy instead of N queries so the dashboard stays cheap even
    // with hundreds of active activities. Single round-trip after the
    // activities list is known.
    const activityIds = bookingsByCategory.map((a: any) => a.id);
    const revenueByActivity = activityIds.length > 0
      ? await db.booking.groupBy({
          by: ['activityId'],
          where: {
            activityId: { in: activityIds },
            status: { not: 'CANCELLED' },
            payment: { status: 'SUCCESS' },
          },
          _sum: { totalPrice: true, commissionAmount: true },
        })
      : [];
    const revMap = new Map(
      revenueByActivity.map((r) => [
        r.activityId,
        Number(r._sum.totalPrice ?? 0) - Number(r._sum.commissionAmount ?? 0),
      ]),
    );

    const topActivities = bookingsByCategory.map((a: any) => ({
      name: a.titleEn,
      category: a.category?.nameEn ?? 'Uncategorized',
      bookings: a._count.bookings,
      revenue: revMap.get(a.id) ?? 0,
    }));

    return { revenueByMonth, topActivities, vendorsByMonth };
  }

  // ─── Admin Notifications (counts) ─────────────────────────────
  async getNotificationCounts(adminUserId?: string) {
    const db = this.prisma.client;
    const [pendingVendors, pendingActivities, pendingCoupons, unreadNotifications] = await Promise.all([
      db.vendor.count({ where: { status: 'PENDING' } }),
      db.activity.count({ where: { status: 'PENDING' } }),
      db.coupon.count({ where: { status: 'PENDING' } }),
      adminUserId ? db.notification.count({ where: { userId: adminUserId, read: false } }) : Promise.resolve(0),
    ]);
    return {
      pendingVendors,
      pendingActivities,
      pendingCoupons,
      unreadNotifications,
      total: pendingVendors + pendingActivities + pendingCoupons,
    };
  }

  // ─── Global Search ────────────────────────────────────────────
  async globalSearch(search: string) {
    const db = this.prisma.client;
    const take = 5;

    const [users, vendors, activities, bookings] = await Promise.all([
      db.user.findMany({
        where: { OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, fullName: true, email: true, role: true },
        take,
      }),
      db.vendor.findMany({
        where: { OR: [
          { businessNameEn: { contains: search, mode: 'insensitive' } },
          { businessNameAr: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, businessNameEn: true, status: true },
        take,
      }),
      db.activity.findMany({
        where: { OR: [
          { titleEn: { contains: search, mode: 'insensitive' } },
          { titleAr: { contains: search, mode: 'insensitive' } },
        ]},
        select: { id: true, titleEn: true, status: true },
        take,
      }),
      db.booking.findMany({
        where: { OR: [
          { ref: { contains: search, mode: 'insensitive' } },
          { customer: { fullName: { contains: search, mode: 'insensitive' } } },
        ]},
        select: { id: true, ref: true, status: true },
        take,
      }),
    ]);

    return { users, vendors, activities, bookings };
  }

  // ─── Bulk Actions ─────────────────────────────────────────────
  async bulkUpdateVendorStatus(vendorIds: string[], status: string) {
    const result = await this.prisma.client.vendor.updateMany({
      where: { id: { in: vendorIds } },
      data: { status: status as any },
    });
    return { updated: result.count };
  }

  async bulkUpdateActivityStatus(activityIds: string[], status: string) {
    const result = await this.prisma.client.activity.updateMany({
      where: { id: { in: activityIds } },
      data: { status: status as any },
    });
    return { updated: result.count };
  }

  /**
   * Bulk soft-delete users.
   *
   * Mirrors single-user `deleteUser` safety + cascade:
   *   1. Refuse if ANY user in the batch is ADMIN (no role-targeted purge).
   *   2. Refuse if ANY user has an unresolved booking (PENDING / CONFIRMED)
   *      as either customer OR vendor side. Either resolve those first
   *      (cancel + refund) or suspend the vendor to trigger the auto-refund
   *      cascade — same operator workflow as single delete.
   *   3. Iterate `deleteUser(userId)` for each user → reuses the tested
   *      $transaction-bound soft-delete cascade (anonymise PII, set
   *      deletedAt + isDeactivated, soft-delete vendor profile + activities,
   *      hard-delete ephemerals: refreshTokens, pushSubscriptions,
   *      notifications, claimedCoupons, likes).
   *
   * The pre-check is atomic across the batch (all-or-nothing): a single
   * blocking user fails the whole batch. The per-user soft-delete is then
   * idempotent — `deleteUser` short-circuits on `deletedAt != null` — so
   * retrying a partially-applied batch is safe.
   *
   * Previous implementation was a hard `deleteMany` that bypassed every
   * safety check + would FK-fail (Prisma P2003) on any user with bookings.
   * That failure mode was inconsistent (admin couldn't tell from the error
   * which user blocked, and a clean batch hard-deleted bookings via cascade
   * loss-of-audit-trail). The new path is explicit + auditable.
   */
  async bulkDeleteUsers(userIds: string[]) {
    if (userIds.length === 0) return { deleted: 0 };

    const db = this.prisma.client;

    // ── 1. Refuse if any in the batch is ADMIN ─────────────────────
    const admins = await db.user.findMany({
      where: { id: { in: userIds }, role: 'ADMIN' },
      select: { id: true, fullName: true },
    });
    if (admins.length > 0) {
      throw new ForbiddenException(
        `Cannot bulk delete admin users (${admins.length} of ${userIds.length} are ADMIN).`,
      );
    }

    // ── 2. Refuse if any user has unresolved bookings ─────────────
    // Two angles per the single-user pattern: bookings as customer, and
    // bookings on vendor activities (via vendor.userId join). One Promise.all
    // = two count queries regardless of batch size.
    const [blockingAsCustomer, blockingAsVendor] = await Promise.all([
      db.booking.count({
        where: {
          customerId: { in: userIds },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      }),
      db.booking.count({
        where: {
          vendor: { userId: { in: userIds } },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      }),
    ]);
    const totalBlocking = blockingAsCustomer + blockingAsVendor;
    if (totalBlocking > 0) {
      throw new ForbiddenException(
        `Cannot bulk delete: ${totalBlocking} unresolved booking(s) in the batch (${blockingAsCustomer} as customer, ${blockingAsVendor} as vendor). Resolve or suspend the relevant vendor first.`,
      );
    }

    // ── 3. Iterate single-user soft-delete (idempotent) ────────────
    // `deleteUser` is idempotent on already-deletedAt rows so a replay of
    // this bulk call after a partial failure is safe. Sequential is fine —
    // bulk is capped at 100 user IDs (BulkDeleteUsersDto.ArrayMaxSize) and
    // each soft-delete is a single transaction.
    let deleted = 0;
    for (const userId of userIds) {
      await this.deleteUser(userId);
      deleted++;
    }
    return { deleted };
  }

  // ─── Export Data ──────────────────────────────────────────────
  // Export endpoints share the same pagination + ordering contract as
  // exportPayouts (defined above): ExportPaginationDto gives a higher
  // ceiling (5000 max) than the standard PaginationDto, suitable for
  // admin CSV exports. Stable `[createdAt desc, id desc]` tie-break so
  // rows created in the same second don't shuffle between pages.
  //
  // Without these caps, a /admin/export/{users,vendors,activities,bookings}
  // call would `findMany({})` with no `take` limit — fine today at a few
  // thousand rows but a memory + DB-CPU bomb once the platform scales.

  async exportUsers(role: string | undefined, query: ExportPaginationDto = {}) {
    // Whitelist the role value to avoid injecting arbitrary strings into the WHERE clause.
    // Exports are role-scoped by policy — no mixed-role CSVs allowed.
    const ALLOWED_ROLES = ['CUSTOMER', 'VENDOR', 'ADMIN'] as const;
    const where: Prisma.UserWhereInput = {};
    if (role && (ALLOWED_ROLES as readonly string[]).includes(role)) {
      where.role = role as (typeof ALLOWED_ROLES)[number];
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 1_000;
    return this.prisma.client.user.findMany({
      where,
      select: { id: true, fullName: true, email: true, phone: true, role: true, isDeactivated: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: (page - 1) * limit,
    });
  }

  async exportVendors(query: ExportPaginationDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 1_000;
    return this.prisma.client.vendor.findMany({
      include: {
        user: { select: { fullName: true, email: true } },
        country: { select: { nameEn: true } },
        _count: { select: { activities: true, bookings: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: (page - 1) * limit,
    });
  }

  async exportActivities(query: ExportPaginationDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 1_000;
    return this.prisma.client.activity.findMany({
      include: {
        vendor: { select: { businessNameEn: true } },
        country: { select: { nameEn: true } },
        category: { select: { nameEn: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: (page - 1) * limit,
    });
  }

  async exportBookings(query: ExportPaginationDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 1_000;
    return this.prisma.client.booking.findMany({
      include: {
        customer: { select: { fullName: true, email: true } },
        activity: { select: { titleEn: true } },
        vendor: { select: { businessNameEn: true } },
        payment: { select: { status: true, method: true, paidAt: true, amount: true, gatewayTxnId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: (page - 1) * limit,
    });
  }

  // ─── Email Suppression List (admin) ─────────────────────────────────────
  async listEmailSuppressions(query: { page?: number; limit?: number; reason?: string }) {
    const page = Number(query.page ?? 1);
    const limit = Math.min(Number(query.limit ?? 50), 100);
    const skip = (page - 1) * limit;

    const where = query.reason ? { reason: query.reason } : {};

    // groupBy returns per-reason counts in one query — sent alongside the
    // page so the UI can show "12 bounces · 3 complaints · 0 manual" without
    // a second round-trip. Always computed over the full table (no `where`)
    // so the counts don't shift when the user filters by reason.
    const [items, total, byReason] = await Promise.all([
      (this.prisma.client as any).emailSuppression.findMany({
        // Only expose the hash + metadata. Never plaintext recipient — we
        // don't store it (see EmailSuppressionService). Admin must compute
        // SHA-256(email) client-side to look up a specific address.
        select: {
          emailHash: true,
          reason: true,
          bounceType: true,
          notes: true,
          createdAt: true,
        },
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      (this.prisma.client as any).emailSuppression.count({ where }),
      (this.prisma.client as any).emailSuppression.groupBy({
        by: ['reason'],
        _count: { _all: true },
      }),
    ]);

    const counts: Record<string, number> = { BOUNCE: 0, COMPLAINT: 0, MANUAL: 0 };
    for (const row of byReason as Array<{ reason: string; _count: { _all: number } }>) {
      counts[row.reason] = row._count._all;
    }

    return { items, total, page, limit, counts };
  }
}
