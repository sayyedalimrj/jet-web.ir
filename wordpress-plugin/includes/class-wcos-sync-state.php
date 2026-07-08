<?php
/**
 * Sync state / cursor storage (WCOS_Sync_State).
 *
 * Persists per-entity sync cursors, last successful sync timestamps, and the active sync run id
 * so chunked background sync can resume safely after failures or timeouts.
 *
 * @package WordPress_Commerce_OS_Companion
 */

defined('ABSPATH') || exit;

if (!class_exists('WCOS_Sync_State')) {
    final class WCOS_Sync_State {

        const OPT_PREFIX = 'wcos_sync_cursor_';
        const OPT_RUN_ID = 'wcos_sync_run_id';
        const OPT_LAST_HANDSHAKE = 'wcos_last_handshake_at';
        const OPT_LAST_SYNC = 'wcos_last_sync_at';
        const OPT_LAST_EVENT = 'wcos_last_event_delivery_at';
        const OPT_LAST_ERROR = 'wcos_last_delivery_error';
        const OPT_QUEUE = 'wcos_sync_queue';

        /** @return int */
        public static function batch_size() {
            $size = (int) get_option('wcos_sync_batch_size', 50);
            return max(10, min(100, $size));
        }

        /**
         * @param string $entity Entity key (categories|products|orders|customers|coupons).
         * @return int
         */
        public static function get_cursor($entity) {
            return (int) get_option(self::OPT_PREFIX . sanitize_key($entity), 0);
        }

        /**
         * @param string $entity Entity key.
         * @param int    $page   Next page/cursor.
         * @return void
         */
        public static function set_cursor($entity, $page) {
            update_option(self::OPT_PREFIX . sanitize_key($entity), max(0, (int) $page), false);
        }

        /** @return void */
        public static function reset_all_cursors() {
            foreach (array('categories', 'products', 'orders', 'customers', 'coupons') as $entity) {
                delete_option(self::OPT_PREFIX . $entity);
            }
        }

        /** @return string */
        public static function get_or_create_run_id() {
            $run = (string) get_option(self::OPT_RUN_ID, '');
            if ($run === '') {
                $run = function_exists('wp_generate_uuid4') ? wp_generate_uuid4() : uniqid('sync_', true);
                update_option(self::OPT_RUN_ID, $run, false);
            }
            return $run;
        }

        /** @return void */
        public static function clear_run_id() {
            delete_option(self::OPT_RUN_ID);
        }

        /**
         * @param string|null $error Redacted error message.
         * @return void
         */
        public static function record_success($kind) {
            $ts = gmdate('c');
            if ($kind === 'handshake') {
                update_option(self::OPT_LAST_HANDSHAKE, $ts, false);
            } elseif ($kind === 'sync') {
                update_option(self::OPT_LAST_SYNC, $ts, false);
                delete_option(self::OPT_LAST_ERROR);
            } elseif ($kind === 'events') {
                update_option(self::OPT_LAST_EVENT, $ts, false);
            }
        }

        /**
         * @param string $error Redacted error.
         * @return void
         */
        public static function record_error($error) {
            update_option(self::OPT_LAST_ERROR, WCOS_Redaction::redact_text((string) $error), false);
        }

        /** @return array<string,mixed> */
        public static function get_status_summary() {
            return array(
                'batchSize'        => self::batch_size(),
                'syncRunId'        => (string) get_option(self::OPT_RUN_ID, ''),
                'lastHandshakeAt'  => get_option(self::OPT_LAST_HANDSHAKE, null),
                'lastSyncAt'       => get_option(self::OPT_LAST_SYNC, null),
                'lastEventAt'      => get_option(self::OPT_LAST_EVENT, null),
                'lastError'        => get_option(self::OPT_LAST_ERROR, null),
                'cursors'          => array(
                    'categories' => self::get_cursor('categories'),
                    'products'   => self::get_cursor('products'),
                    'orders'     => self::get_cursor('orders'),
                    'customers'  => self::get_cursor('customers'),
                    'coupons'    => self::get_cursor('coupons'),
                ),
                'queue'            => self::get_queue(),
            );
        }

        /** @return array<int,string> */
        public static function get_queue() {
            $q = get_option(self::OPT_QUEUE, array());
            return is_array($q) ? $q : array();
        }

        /**
         * @param array<int,string> $entities Ordered entity names for full sync.
         * @return void
         */
        public static function start_full_sync_queue(array $entities) {
            self::reset_all_cursors();
            self::clear_run_id();
            self::get_or_create_run_id();
            update_option(self::OPT_QUEUE, array_values($entities), false);
        }

        /** @return string|null Next entity or null if queue empty. */
        public static function pop_queue_entity() {
            $q = self::get_queue();
            if (empty($q)) {
                return null;
            }
            $next = array_shift($q);
            update_option(self::OPT_QUEUE, $q, false);
            return is_string($next) ? $next : null;
        }

        /** @return bool */
        public static function queue_is_active() {
            return !empty(self::get_queue()) || self::get_cursor('products') > 0 || self::get_cursor('orders') > 0;
        }
    }
}
