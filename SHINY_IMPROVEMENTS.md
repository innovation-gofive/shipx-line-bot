# Shiny: guided questions, reports and Reorder alerts

## What the supplied audit shows

The supplied export contains 281 audit events from 4–23 November 2026. There are 88 events on 23 November, including 17 received messages. Events are processing stages, not separate customer questions. The same message can produce received, AI classification, API and presentation events.

On 23 November the log contains 18 successful AI selections, 6 generated presentations and 1 presentation fallback. A fallback is not evidence that every AI call failed. Older events often have no question/error detail, so their original text and failure cause cannot be reconstructed from this file.

| Question or situation | Finding | Change |
| --- | --- | --- |
| มอนิเตอร์ | No deterministic route | Today's order overview |
| มอนิเตอร์สต็อกหน่อย | Stock lookup required a single SKU | Company-scoped stock overview |
| สต็อกSKU ไหนใกล้หมด / สต็อกไหนใกล้หมดบ้าง | No low-stock intent | Sellable stock at/below ShipX reorderPoint |
| สวัสดีผมชื่อ… | Greeting and name combination not recognized | Friendly greeting and scoped name memory |
| เก่งมาก | Fell through to generic help | Friendly acknowledgement |
| help / empty bot mention | Plain help text | Three-button permission-scoped Flex menu |
| ความคืบหน้าแพ็ค | AI selected shipping but API failed pagination verification | Local route plus count-based pagination support |
| Shipping follow-up notification | order_pagination_not_verified | Recognize verified items/orders/data plus pagination totals; record safe response-shape diagnostics |
| 117-order overview | Closed orders were absent from the visible rows | Show all exclusive status buckets and keep gross/cancelled/active totals |

Order and SKU examples did succeed in the log. Not-found outcomes must remain not-found unless ShipX verifies a matching record in the mapped company. These changes do not fabricate a successful lookup.

## Guided questions and conversation

Tag Shiny in LINE and type `help`. The menu offers **มอนิเตอร์ออเดอร์**, **ภาพรวมสต็อก**, **รายงานการจัดส่ง**, subject to the group's permissions. Replies include related follow-up buttons. Reorder lists paginate with **ดู SKU ถัดไป** when more than eight SKUs match.

Buttons use opaque server-stored postback tokens bound to group, company, mapping revision and a 24-hour expiry. A copied card cannot query another group's company. Permissions are checked again before API calls and replies. Ordinary text still requires a genuine bot mention. A valid button click is an explicit follow-up action and does not need another mention.

Shiny introduces herself as a female assistant working with ShipX. Tagged greetings, a greeting combined with a name, and thanks/compliments have friendly responses. Explicit help opens the topic menu. Unanswered customer questions now receive a human-support card and a durable Admin case, with optional LINE notifications to the internal Admin group. See [the Admin support guide](ADMIN_SUPPORT.md).

## Reports and visual changes

- Order cards use ShipX-inspired status colours, including purple for packing and yellow for packed/waiting shipment. AI formatting preserves the colour.
- Order overview shows gross total, cancellation and active total, then nonoverlapping status groups including closed work and unknown statuses. Long AI prose is kept out of the visual report card.
- Daily shipping cards omit zero channels, show official platform icons for Shopee/Lazada/TikTok, keep B2B separate and retain a highlighted Total. B2B Express stays included in B2B.
- Admin has Shiny/ShipX branding, clearer spacing, schedule summaries and interactive Flex previews in the command tester. Tester actions do not send LINE messages.

## Reorder alerts

In **กลุ่มลูกค้า → ตั้งค่า**, enable the group and stock permission, then enable **แจ้งเตือนสินค้าถึงจุด Reorder**. The default time is **09:00 Asia/Bangkok**, independently editable for each group.

The comparison is `currentStock <= reorderPoint` from ShipX Stock Analytics. `currentStock` is sellable stock. Incoming/put-away quantities are excluded. Missing thresholds are exposed as unavailable, not treated as zero. Product variant/master ownership is verified against the company's catalogue before showing quantities.

The scheduler checks every 30 seconds within a 15-minute window, persists delivery state, uses LINE retry keys and deduplicates each notification kind per group/day. Stock permission is sufficient for Reorder alerts; order-report permission is independent. New alerts are disabled by default. Changing permissions or company revokes pending work and old buttons.

## Sticker options researched, not implemented

1. **Standard LINE stickers:** Messaging API can send supported `packageId`/`stickerId` pairs from LINE's published list. A backend whitelist can map greeting/thanks/success moods to approved IDs. AI should choose a mood, not arbitrary sticker IDs.
2. **Custom Shiny artwork:** serve owned artwork over HTTPS and send it as an image or in Flex. It appears as an image/card, not a native sticker object. This is a practical route for a Shiny character set.
3. **Company promotional stickers:** sending company-owned promotional stickers through the API requires the applicable corporate arrangements with LINE. A normal purchased/Creators sticker is not automatically available for API sending.

Official references: [available stickers](https://developers.line.biz/en/docs/messaging-api/sticker-list/), [message types](https://developers.line.biz/en/docs/messaging-api/message-types/), [postback actions](https://developers.line.biz/en/reference/messaging-api/#postback-action).

## Verification and remaining live checks

Tests cover audit phrase regressions, group-scoped postbacks, expiry/revocation, stock ownership, Reorder boundaries, independent schedules, pagination contracts, colours and report reconciliation. Demo previews use synthetic data and send no LINE messages.

The local profile has no saved live ShipX Token or AI key. The new pagination contracts and Stock Analytics calls therefore still need verification against ShipX after a valid token is entered. V3 OpenAPI omits the actual order-list response schema; if its deployed shape differs, the audit now records field-name diagnostics without order contents. Registering a new stock notification time after it has already sent on that date does not trigger a second report.

Recommended follow-ups: display the deployed Git commit in Admin, warn before a manually entered Token expires, and add a filtered view of unanswered questions with their failure stages.
