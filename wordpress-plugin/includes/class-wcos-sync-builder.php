<?php
/**
 * Sync envelope builder (WCOS_Sync_Builder).
 *
 * Reads WooCommerce data locally and builds camelCase envelopes for the backend ingest path.
 * Supports wcos.sync.v1 (legacy flat) and wcos.sync.v2 (chunked) with rich product/order data.
 *
 * @package WordPress_Commerce_OS_Companion
 */

defined('ABSPATH') || exit;

if (!class_exists('WCOS_Sync_Builder')) {
    final class WCOS_Sync_Builder {

        /** Denylisted meta keys (payment tokens, secrets). */
        private static function meta_denylist() {
            return array('_stripe_', '_paypal_', '_wc_', 'password', 'secret', 'token', 'api_key');
        }

        /** @return string */
        public static function currency() {
            return function_exists('get_woocommerce_currency') ? get_woocommerce_currency() : 'IRT';
        }

        /** @return int */
        private static function exponent($currency) {
            $zero = array('IRR', 'IRT', 'JPY');
            return in_array(strtoupper((string) $currency), $zero, true) ? 0 : 2;
        }

        /** @return int */
        private static function to_minor($amount, $currency) {
            return (int) round(((float) $amount) * pow(10, self::exponent($currency)));
        }

        /** @return array<string,mixed> */
        private static function site_block() {
            return array(
                'pluginVersion' => WCOS_VERSION,
                'wooVersion'    => WCOS_WooCommerce::version(),
                'wpVersion'     => function_exists('get_bloginfo') ? get_bloginfo('version') : '',
                'currency'      => self::currency(),
                'hposEnabled'   => WCOS_WooCommerce::is_hpos_enabled(),
                'locale'        => function_exists('get_locale') ? get_locale() : '',
                'timezone'      => function_exists('wp_timezone_string') ? wp_timezone_string() : '',
            );
        }

        /** @return array<string,mixed> */
        public static function build_envelope() {
            $currency = self::currency();
            return array(
                'schemaVersion' => 'wcos.sync.v1',
                'generatedAt'   => gmdate('c'),
                'site'          => self::site_block(),
                'data'          => array(
                    'categories' => self::categories_chunk(1, WCOS_Sync_State::batch_size()),
                    'products'   => self::products_chunk(1, WCOS_Sync_State::batch_size(), $currency),
                    'orders'     => self::orders_chunk(1, WCOS_Sync_State::batch_size(), $currency),
                    'customers'  => self::customers_chunk(1, WCOS_Sync_State::batch_size(), $currency),
                    'coupons'    => self::coupons_chunk(1, WCOS_Sync_State::batch_size(), $currency),
                ),
            );
        }

        /**
         * Build a v2 chunked envelope for one entity page.
         *
         * @param string $entity Entity name.
         * @param int    $page   1-based page.
         * @return array<string,mixed>
         */
        public static function build_chunk_envelope($entity, $page) {
            $currency = self::currency();
            $limit    = WCOS_Sync_State::batch_size();
            $data     = array();
            $count    = 0;
            $has_more = false;

            switch ($entity) {
                case 'categories':
                    $items = self::categories_chunk($page, $limit + 1);
                    $has_more = count($items) > $limit;
                    $data['categories'] = array_slice($items, 0, $limit);
                    $count = count($data['categories']);
                    break;
                case 'products':
                    $items = self::products_chunk($page, $limit + 1, $currency);
                    $has_more = count($items) > $limit;
                    $data['products'] = array_slice($items, 0, $limit);
                    $count = count($data['products']);
                    break;
                case 'orders':
                    $items = self::orders_chunk($page, $limit + 1, $currency);
                    $has_more = count($items) > $limit;
                    $data['orders'] = array_slice($items, 0, $limit);
                    $count = count($data['orders']);
                    break;
                case 'customers':
                    $items = self::customers_chunk($page, $limit + 1, $currency);
                    $has_more = count($items) > $limit;
                    $data['customers'] = array_slice($items, 0, $limit);
                    $count = count($data['customers']);
                    break;
                case 'coupons':
                    $items = self::coupons_chunk($page, $limit + 1, $currency);
                    $has_more = count($items) > $limit;
                    $data['coupons'] = array_slice($items, 0, $limit);
                    $count = count($data['coupons']);
                    break;
                default:
                    $data = array();
            }

            return array(
                'schemaVersion' => 'wcos.sync.v2',
                'generatedAt'   => gmdate('c'),
                'syncRunId'     => WCOS_Sync_State::get_or_create_run_id(),
                'chunk'         => array(
                    'entity'       => $entity,
                    'chunkNumber'  => $page,
                    'page'         => $page,
                    'isFinal'      => !$has_more,
                    'recordCount'  => $count,
                ),
                'site'          => self::site_block(),
                'data'          => $data,
                '_meta'         => array('hasMore' => $has_more, 'count' => $count),
            );
        }

        /** @return array<int,array<string,mixed>> */
        private static function categories_chunk($page, $limit) {
            if (!WCOS_WooCommerce::is_active()) {
                return array();
            }
            $offset = max(0, ($page - 1) * $limit);
            $terms  = get_terms(array(
                'taxonomy'   => 'product_cat',
                'hide_empty' => false,
                'number'     => $limit,
                'offset'     => $offset,
                'orderby'    => 'term_id',
                'order'      => 'ASC',
            ));
            if (is_wp_error($terms) || !is_array($terms)) {
                return array();
            }
            $out = array();
            foreach ($terms as $t) {
                $thumb_id = get_term_meta($t->term_id, 'thumbnail_id', true);
                $out[] = array(
                    'externalId'       => (string) $t->term_id,
                    'name'             => $t->name,
                    'slug'             => $t->slug,
                    'description'      => $t->description,
                    'parentExternalId' => $t->parent ? (string) $t->parent : null,
                    'count'            => (int) $t->count,
                    'thumbnailId'      => $thumb_id ? (string) $thumb_id : null,
                );
            }
            return $out;
        }

        /** @return array<int,array<string,mixed>> */
        private static function products_chunk($page, $limit, $currency) {
            if (!WCOS_WooCommerce::is_active() || !function_exists('wc_get_products')) {
                return array();
            }
            $products = wc_get_products(array(
                'limit'   => $limit,
                'page'    => max(1, $page),
                'status'  => array('publish', 'draft', 'pending', 'private'),
                'orderby' => 'ID',
                'order'   => 'ASC',
                'return'  => 'objects',
            ));
            $items = array();
            foreach ($products as $p) {
                $items[] = self::map_product_sync($p, $currency);
            }
            return $items;
        }

        /**
         * Lightweight product map for chunked sync — omits variations/meta/heavy fields so each
         * chunk stays small and fast while preserving catalog + stock essentials.
         *
         * @return array<string,mixed>
         */
        private static function map_product_sync($p, $currency) {
            $cats = array();
            foreach ($p->get_category_ids() as $cid) {
                $term = get_term($cid, 'product_cat');
                if ($term && !is_wp_error($term)) {
                    $cats[] = array('externalId' => (string) $term->term_id, 'name' => $term->name, 'slug' => $term->slug);
                }
            }
            $tags = array();
            foreach ($p->get_tag_ids() as $tid) {
                $term = get_term($tid, 'product_tag');
                if ($term && !is_wp_error($term)) {
                    $tags[] = array('externalId' => (string) $term->term_id, 'name' => $term->name, 'slug' => $term->slug);
                }
            }
            $images = array();
            $thumb  = wp_get_attachment_image_src($p->get_image_id(), 'woocommerce_thumbnail');
            if ($thumb) {
                $images[] = array(
                    'externalId' => (string) $p->get_image_id(),
                    'src'        => $thumb[0],
                    'alt'        => get_post_meta($p->get_image_id(), '_wp_attachment_image_alt', true),
                    'position'   => 0,
                );
            }
            return array(
                'externalId'        => (string) $p->get_id(),
                'name'              => $p->get_name(),
                'slug'              => $p->get_slug(),
                'permalink'         => $p->get_permalink(),
                'sku'               => $p->get_sku(),
                'status'            => $p->get_status(),
                'type'              => $p->get_type(),
                'regularPriceMinor' => self::to_minor($p->get_regular_price(), $currency),
                'salePriceMinor'    => $p->get_sale_price() !== '' ? self::to_minor($p->get_sale_price(), $currency) : null,
                'priceMinor'        => self::to_minor($p->get_price(), $currency),
                'currency'          => $currency,
                'stockStatus'       => $p->get_stock_status(),
                'stockQty'          => $p->managing_stock() ? (int) $p->get_stock_quantity() : null,
                'manageStock'       => $p->managing_stock(),
                'categories'        => $cats,
                'tags'              => $tags,
                'images'            => $images,
                'variations'        => array(),
                'totalSales'        => (int) $p->get_total_sales(),
                'dateModified'      => $p->get_date_modified() ? $p->get_date_modified()->date('c') : null,
            );
        }

        /** @return array<string,mixed> */
        private static function map_product($p, $currency) {
            $cats = array();
            foreach ($p->get_category_ids() as $cid) {
                $term = get_term($cid, 'product_cat');
                if ($term && !is_wp_error($term)) {
                    $cats[] = array('externalId' => (string) $term->term_id, 'name' => $term->name, 'slug' => $term->slug);
                }
            }
            $tags = array();
            foreach ($p->get_tag_ids() as $tid) {
                $term = get_term($tid, 'product_tag');
                if ($term && !is_wp_error($term)) {
                    $tags[] = array('externalId' => (string) $term->term_id, 'name' => $term->name, 'slug' => $term->slug);
                }
            }
            $brands = self::product_brands($p);
            $images = array();
            $thumb  = wp_get_attachment_image_src($p->get_image_id(), 'full');
            if ($thumb) {
                $images[] = array('externalId' => (string) $p->get_image_id(), 'src' => $thumb[0], 'alt' => get_post_meta($p->get_image_id(), '_wp_attachment_image_alt', true), 'position' => 0);
            }
            foreach ($p->get_gallery_image_ids() as $i => $gid) {
                $src = wp_get_attachment_image_src($gid, 'full');
                if ($src) {
                    $images[] = array('externalId' => (string) $gid, 'src' => $src[0], 'alt' => get_post_meta($gid, '_wp_attachment_image_alt', true), 'position' => $i + 1);
                }
            }
            $attrs = array();
            foreach ($p->get_attributes() as $attr) {
                if (!is_object($attr)) {
                    continue;
                }
                $attrs[] = array(
                    'name'      => $attr->get_name(),
                    'slug'      => $attr->get_name(),
                    'options'   => $attr->get_options(),
                    'isVariation' => $attr->get_variation(),
                    'isVisible'   => $attr->get_visible(),
                    'position'    => $attr->get_position(),
                );
            }
            $variations = array();
            if ($p->is_type('variable') && method_exists($p, 'get_children')) {
                foreach (array_slice($p->get_children(), 0, 50) as $vid) {
                    $v = wc_get_product($vid);
                    if (!$v) {
                        continue;
                    }
                    $variations[] = self::map_variation($v, $currency);
                }
            }
            return array(
                'externalId'        => (string) $p->get_id(),
                'name'              => $p->get_name(),
                'slug'              => $p->get_slug(),
                'permalink'         => $p->get_permalink(),
                'sku'               => $p->get_sku(),
                'status'            => $p->get_status(),
                'type'              => $p->get_type(),
                'shortDescription'  => wp_strip_all_tags($p->get_short_description()),
                'description'       => wp_strip_all_tags($p->get_description()),
                'regularPriceMinor' => self::to_minor($p->get_regular_price(), $currency),
                'salePriceMinor'    => $p->get_sale_price() !== '' ? self::to_minor($p->get_sale_price(), $currency) : null,
                'priceMinor'        => self::to_minor($p->get_price(), $currency),
                'currency'          => $currency,
                'stockStatus'       => $p->get_stock_status(),
                'stockQty'          => $p->managing_stock() ? (int) $p->get_stock_quantity() : null,
                'manageStock'       => $p->managing_stock(),
                'backorders'        => $p->get_backorders(),
                'lowStockAmount'    => $p->get_low_stock_amount(),
                'soldIndividually'  => $p->is_sold_individually(),
                'virtual'           => $p->is_virtual(),
                'downloadable'      => $p->is_downloadable(),
                'weight'            => $p->get_weight(),
                'dimensions'        => array('length' => $p->get_length(), 'width' => $p->get_width(), 'height' => $p->get_height()),
                'shippingClass'     => $p->get_shipping_class(),
                'taxStatus'         => $p->get_tax_status(),
                'taxClass'          => $p->get_tax_class(),
                'categories'        => $cats,
                'tags'              => $tags,
                'brands'            => $brands,
                'attributes'        => $attrs,
                'images'            => $images,
                'variations'        => $variations,
                'averageRating'     => (float) $p->get_average_rating(),
                'ratingCount'       => (int) $p->get_rating_count(),
                'totalSales'        => (int) $p->get_total_sales(),
                'meta'              => self::safe_meta($p->get_meta_data()),
                'dateModified'      => $p->get_date_modified() ? $p->get_date_modified()->date('c') : null,
            );
        }

        /** @return array<string,mixed> */
        private static function map_variation($v, $currency) {
            $attrs = array();
            foreach ($v->get_attributes() as $k => $val) {
                $attrs[] = array('name' => $k, 'option' => $val);
            }
            return array(
                'externalId'  => (string) $v->get_id(),
                'sku'         => $v->get_sku(),
                'priceMinor'  => self::to_minor($v->get_price(), $currency),
                'stockStatus' => $v->get_stock_status(),
                'stockQty'    => $v->managing_stock() ? (int) $v->get_stock_quantity() : null,
                'attributes'  => $attrs,
                'meta'        => self::safe_meta($v->get_meta_data()),
            );
        }

        /** @return array<int,array<string,mixed>> */
        private static function product_brands($p) {
            $brands = array();
            foreach (array('product_brand', 'pwb-brand', 'yith_product_brand') as $tax) {
                if (!taxonomy_exists($tax)) {
                    continue;
                }
                $terms = wp_get_post_terms($p->get_id(), $tax);
                if (is_wp_error($terms)) {
                    continue;
                }
                foreach ($terms as $t) {
                    $brands[] = array('externalId' => (string) $t->term_id, 'name' => $t->name, 'slug' => $t->slug);
                }
            }
            return $brands;
        }

        /** @param array<int,mixed> $meta_data */
        private static function safe_meta($meta_data) {
            $out = array();
            foreach ($meta_data as $m) {
                if (!is_object($m) || !method_exists($m, 'get_data')) {
                    continue;
                }
                $d = $m->get_data();
                $key = isset($d['key']) ? (string) $d['key'] : '';
                if ($key === '' || self::meta_is_denied($key)) {
                    continue;
                }
                $out[] = array('key' => $key, 'value' => is_scalar($d['value']) ? $d['value'] : '[complex]');
            }
            return $out;
        }

        /** @return bool */
        private static function meta_is_denied($key) {
            $k = strtolower($key);
            foreach (self::meta_denylist() as $deny) {
                if (strpos($k, strtolower($deny)) !== false) {
                    return true;
                }
            }
            return false;
        }

        /** @return array<int,array<string,mixed>> */
        private static function orders_chunk($page, $limit, $currency) {
            if (!WCOS_WooCommerce::is_active() || !function_exists('wc_get_orders')) {
                return array();
            }
            $orders = wc_get_orders(array(
                'limit'   => $limit,
                'page'    => max(1, $page),
                'orderby' => 'ID',
                'order'   => 'ASC',
                'return'  => 'objects',
            ));
            $items = array();
            foreach ($orders as $o) {
                $items[] = self::map_order($o, $currency);
            }
            return $items;
        }

        /** @return array<string,mixed> */
        private static function map_order($o, $currency) {
            $line_items = array();
            foreach ($o->get_items() as $item) {
                $line_items[] = array(
                    'externalId'  => (string) $item->get_id(),
                    'productId'   => (string) $item->get_product_id(),
                    'variationId' => $item->get_variation_id() ? (string) $item->get_variation_id() : null,
                    'name'        => $item->get_name(),
                    'sku'         => $item->get_product() ? $item->get_product()->get_sku() : null,
                    'quantity'    => (float) $item->get_quantity(),
                    'subtotalMinor' => self::to_minor($item->get_subtotal(), $currency),
                    'totalMinor'    => self::to_minor($item->get_total(), $currency),
                );
            }
            $billing = $o->get_address('billing');
            $shipping = $o->get_address('shipping');
            return array(
                'externalId'         => (string) $o->get_id(),
                'number'             => (string) $o->get_order_number(),
                'status'             => $o->get_status(),
                'currency'           => $o->get_currency(),
                'totalMinor'         => self::to_minor($o->get_total(), $currency),
                'subtotalMinor'      => self::to_minor($o->get_subtotal(), $currency),
                'taxMinor'           => self::to_minor($o->get_total_tax(), $currency),
                'shippingMinor'      => self::to_minor($o->get_shipping_total(), $currency),
                'discountMinor'      => self::to_minor($o->get_discount_total(), $currency),
                'customerId'         => $o->get_customer_id() ? (string) $o->get_customer_id() : null,
                'customerName'       => trim($o->get_billing_first_name() . ' ' . $o->get_billing_last_name()),
                'paymentMethodTitle' => $o->get_payment_method_title(),
                'paymentMethodId'    => $o->get_payment_method(),
                'transactionId'      => $o->get_transaction_id() ? (string) $o->get_transaction_id() : null,
                'customerNote'       => $o->get_customer_note(),
                'lineItems'          => $line_items,
                'billing'            => $billing,
                'shipping'           => $shipping,
                'createdAt'          => $o->get_date_created() ? $o->get_date_created()->date('c') : null,
                'modifiedAt'         => $o->get_date_modified() ? $o->get_date_modified()->date('c') : null,
                'paidAt'             => $o->get_date_paid() ? $o->get_date_paid()->date('c') : null,
                'completedAt'        => $o->get_date_completed() ? $o->get_date_completed()->date('c') : null,
            );
        }

        /** @return array<int,array<string,mixed>> */
        private static function customers_chunk($page, $limit, $currency) {
            if (!function_exists('get_users')) {
                return array();
            }
            $offset = max(0, ($page - 1) * $limit);
            $users  = get_users(array(
                'role'    => 'customer',
                'number'  => $limit,
                'offset'  => $offset,
                'orderby' => 'ID',
                'order'   => 'ASC',
            ));
            $items = array();
            foreach ($users as $u) {
                $items[] = self::map_customer($u, $currency);
            }
            return $items;
        }

        /** @return array<string,mixed> */
        private static function map_customer($u, $currency) {
            $orders_count = 0;
            $total_spent  = 0;
            $billing      = array();
            $shipping     = array();
            if (class_exists('WC_Customer')) {
                try {
                    $c = new WC_Customer($u->ID);
                    $orders_count = (int) $c->get_order_count();
                    $total_spent  = $c->get_total_spent();
                    $billing      = $c->get_billing();
                    $shipping     = $c->get_shipping();
                } catch (Exception $e) {
                    // fall through
                }
            }
            return array(
                'externalId'      => (string) $u->ID,
                'displayName'     => $u->display_name,
                'email'           => $u->user_email,
                'username'        => $u->user_login,
                'firstName'       => get_user_meta($u->ID, 'first_name', true),
                'lastName'        => get_user_meta($u->ID, 'last_name', true),
                'billing'         => $billing,
                'shipping'        => $shipping,
                'ordersCount'     => $orders_count,
                'totalSpentMinor' => self::to_minor($total_spent, $currency),
                'currency'        => $currency,
                'dateCreated'     => $u->user_registered,
            );
        }

        /** @return array<int,array<string,mixed>> */
        private static function coupons_chunk($page, $limit, $currency) {
            if (!function_exists('get_posts') || !class_exists('WC_Coupon')) {
                return array();
            }
            $offset = max(0, ($page - 1) * $limit);
            $posts  = get_posts(array(
                'post_type'      => 'shop_coupon',
                'posts_per_page' => $limit,
                'offset'         => $offset,
                'post_status'    => 'publish',
                'orderby'        => 'ID',
                'order'          => 'ASC',
            ));
            $items = array();
            foreach ($posts as $post) {
                try {
                    $coupon = new WC_Coupon($post->ID);
                    $items[] = array(
                        'externalId'    => (string) $post->ID,
                        'code'          => $coupon->get_code(),
                        'discountType'  => $coupon->get_discount_type(),
                        'amountMinor'   => self::to_minor($coupon->get_amount(), $currency),
                        'usageLimit'    => $coupon->get_usage_limit(),
                        'usageCount'    => $coupon->get_usage_count(),
                        'expiryDate'    => $coupon->get_date_expires() ? $coupon->get_date_expires()->date('c') : null,
                        'freeShipping'  => $coupon->get_free_shipping(),
                        'minimumAmount' => $coupon->get_minimum_amount(),
                        'maximumAmount' => $coupon->get_maximum_amount(),
                        'individualUse' => $coupon->get_individual_use(),
                        'excludeSaleItems' => $coupon->get_exclude_sale_items(),
                        'currency'      => $currency,
                    );
                } catch (Exception $e) {
                    continue;
                }
            }
            return $items;
        }
    }
}
