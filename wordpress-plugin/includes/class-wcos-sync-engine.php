<?php
/**
 * Chunked sync engine (WCOS_Sync_Engine).
 *
 * Runs batched, background-friendly sync cycles: one entity page per invocation so large stores
 * never block admin requests or exceed API body limits. Uses Action Scheduler when available,
 * otherwise WP-Cron single events.
 *
 * @package WordPress_Commerce_OS_Companion
 */

defined('ABSPATH') || exit;

if (!class_exists('WCOS_Sync_Engine')) {
    final class WCOS_Sync_Engine {

        const HOOK_CHUNK = 'wcos_sync_chunk';
        const HOOK_EVENTS = 'wcos_deliver_events';
        const HOOK_HEALTH = 'wcos_scheduled_health';

        /** @return void */
        public static function init() {
            add_action(self::HOOK_CHUNK, array(__CLASS__, 'run_next_chunk'));
            add_action(self::HOOK_EVENTS, array(__CLASS__, 'deliver_pending_events'));
            add_action(self::HOOK_HEALTH, array(__CLASS__, 'run_health'));
        }

        /** Schedule the full sync queue (non-blocking). Orders first so dashboard charts populate sooner. */
        public static function schedule_full_sync() {
            WCOS_Sync_State::start_full_sync_queue(
                array('orders', 'customers', 'products', 'categories', 'coupons')
            );
            self::schedule_chunk(2);
        }

        /** Schedule incremental sync for high-churn entities. */
        public static function schedule_incremental_sync() {
            WCOS_Sync_State::start_full_sync_queue(array('orders', 'products', 'customers', 'coupons'));
            self::schedule_chunk(5);
        }

        /**
         * @param int $delay Seconds before next chunk.
         * @return void
         */
        public static function schedule_chunk($delay = 10) {
            if (function_exists('as_schedule_single_action')) {
                as_schedule_single_action(time() + $delay, self::HOOK_CHUNK, array(), 'wcos');
                return;
            }
            wp_schedule_single_event(time() + $delay, self::HOOK_CHUNK);
        }

        /** @return void */
        public static function schedule_event_delivery($delay = 15) {
            if (function_exists('as_schedule_single_action')) {
                as_schedule_single_action(time() + $delay, self::HOOK_EVENTS, array(), 'wcos');
                return;
            }
            wp_schedule_single_event(time() + $delay, self::HOOK_EVENTS);
        }

        /** @return void */
        public static function run_next_chunk() {
            if (!WCOS_Settings::is_configured()) {
                return;
            }

            $queue = WCOS_Sync_State::get_queue();
            if (empty($queue)) {
                WCOS_Sync_State::clear_run_id();
                return;
            }

            $entity = $queue[0];
            $page   = WCOS_Sync_State::get_cursor($entity);
            if ($page < 1) {
                $page = 1;
            }

            $result = WCOS_Backend_Client::sync_chunk($entity, $page);
            if (empty($result['ok'])) {
                $err = isset($result['error']) ? (string) $result['error'] : 'sync failed';
                WCOS_Sync_State::record_error($err);
                update_option('wcos_sync_fail_count', 1 + (int) get_option('wcos_sync_fail_count', 0), false);
                self::schedule_chunk(min(3600, 60 * (int) get_option('wcos_sync_fail_count', 1)));
                return;
            }

            delete_option('wcos_sync_fail_count');
            WCOS_Sync_State::record_success('sync');

            $has_more = !empty($result['hasMore']);
            if ($has_more) {
                WCOS_Sync_State::set_cursor($entity, $page + 1);
                self::schedule_chunk(3);
                return;
            }

            WCOS_Sync_State::set_cursor($entity, 0);
            array_shift($queue);
            update_option(WCOS_Sync_State::OPT_QUEUE, $queue, false);

            if (!empty($queue)) {
                self::schedule_chunk(2);
            } else {
                WCOS_Sync_State::clear_run_id();
            }
        }

        /** @return void */
        public static function deliver_pending_events() {
            if (!WCOS_Settings::is_configured()) {
                return;
            }
            $result = WCOS_Event_Deliverer::deliver_batch();
            if (!empty($result['ok'])) {
                WCOS_Sync_State::record_success('events');
            } elseif (!empty($result['error'])) {
                WCOS_Sync_State::record_error($result['error']);
            }
            if (WCOS_Event_Store::count() > 0) {
                self::schedule_event_delivery(30);
            }
        }

        /** @return void */
        public static function run_health() {
            if (!WCOS_Settings::is_configured()) {
                return;
            }
            $result = WCOS_Backend_Client::health();
            if (!empty($result['ok'])) {
                WCOS_Sync_State::record_success('handshake');
            }
        }
    }
}
