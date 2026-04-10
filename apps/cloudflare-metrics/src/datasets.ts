import type { DatasetQuery } from './types.js';

/**
 * One-minute bucket granularity via the `datetimeMinute` dimension — the
 * finest grouping the Cloudflare Analytics API exposes. The exporter runs
 * on a 5-minute cron and the collector uses a wider window so each run
 * overlaps with the previous one (VictoriaMetrics dedupes by series +
 * timestamp so overlap is free).
 *
 * Dimension → tag mapping and field names use snake_case to match the
 * existing VictoriaMetrics conventions in other workers.
 */

export const WORKERS_INVOCATIONS: DatasetQuery = {
  key: 'workers_invocations',
  measurement: 'cf_workers_invocations',
  field: 'workersInvocationsAdaptive',
  dimensions: ['datetimeMinute', 'scriptName', 'status', 'scriptVersion', 'usageModel'],
  blocks: {
    sum: [
      'requests',
      'errors',
      'subrequests',
      'clientDisconnects',
      'cpuTimeUs',
      'duration',
      'wallTime',
      'responseBodySize',
    ],
    max: ['cpuTime', 'duration', 'wallTime', 'requestDuration', 'responseBodySize'],
    quantiles: [
      'cpuTimeP50',
      'cpuTimeP99',
      'durationP50',
      'durationP99',
      'wallTimeP50',
      'wallTimeP99',
      'responseBodySizeP99',
    ],
  },
  tags: [
    { source: 'scriptName', as: 'script_name' },
    { source: 'status', as: 'status' },
    { source: 'scriptVersion', as: 'script_version' },
    { source: 'usageModel', as: 'usage_model' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    errors: { type: 'int', source: ['sum', 'errors'] },
    subrequests: { type: 'int', source: ['sum', 'subrequests'] },
    client_disconnects: { type: 'int', source: ['sum', 'clientDisconnects'] },
    cpu_time_us_sum: { type: 'int', source: ['sum', 'cpuTimeUs'] },
    // `duration` here is seconds from the API — convert to milliseconds.
    duration_ms_sum: { type: 'float', source: ['sum', 'duration'], scale: 1000 },
    wall_time_us_sum: { type: 'int', source: ['sum', 'wallTime'] },
    response_body_size_bytes_sum: { type: 'int', source: ['sum', 'responseBodySize'] },
    cpu_time_us_max: { type: 'int', source: ['max', 'cpuTime'] },
    duration_ms_max: { type: 'float', source: ['max', 'duration'], scale: 1000 },
    wall_time_us_max: { type: 'int', source: ['max', 'wallTime'] },
    request_duration_us_max: { type: 'int', source: ['max', 'requestDuration'] },
    response_body_size_bytes_max: { type: 'int', source: ['max', 'responseBodySize'] },
    cpu_time_us_p50: { type: 'int', source: ['quantiles', 'cpuTimeP50'] },
    cpu_time_us_p99: { type: 'int', source: ['quantiles', 'cpuTimeP99'] },
    duration_ms_p50: { type: 'float', source: ['quantiles', 'durationP50'], scale: 1000 },
    duration_ms_p99: { type: 'float', source: ['quantiles', 'durationP99'], scale: 1000 },
    wall_time_us_p50: { type: 'int', source: ['quantiles', 'wallTimeP50'] },
    wall_time_us_p99: { type: 'int', source: ['quantiles', 'wallTimeP99'] },
    response_body_size_bytes_p99: { type: 'int', source: ['quantiles', 'responseBodySizeP99'] },
  },
};

export const WORKERS_SUBREQUESTS: DatasetQuery = {
  key: 'workers_subrequests',
  measurement: 'cf_workers_subrequests',
  field: 'workersSubrequestsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'scriptName', 'hostname', 'cacheStatus', 'httpResponseStatus', 'requestOutcome'],
  blocks: {
    sum: [
      'subrequests',
      'requestBodySize',
      'requestBodySizeUncached',
      'responseBodySize',
      'timeToResponseUs',
      'timeToResponseDrainedUs',
    ],
  },
  tags: [
    { source: 'scriptName', as: 'script_name' },
    { source: 'hostname', as: 'hostname' },
    { source: 'cacheStatus', as: 'cache_status' },
    { source: 'httpResponseStatus', as: 'http_response_status' },
    { source: 'requestOutcome', as: 'request_outcome' },
  ],
  fields: {
    subrequests: { type: 'int', source: ['sum', 'subrequests'] },
    request_body_size_bytes: { type: 'int', source: ['sum', 'requestBodySize'] },
    request_body_size_uncached_bytes: { type: 'int', source: ['sum', 'requestBodySizeUncached'] },
    response_body_size_bytes: { type: 'int', source: ['sum', 'responseBodySize'] },
    time_to_response_us: { type: 'int', source: ['sum', 'timeToResponseUs'] },
    time_to_response_drained_us: { type: 'int', source: ['sum', 'timeToResponseDrainedUs'] },
  },
};

export const WORKERS_OVERVIEW: DatasetQuery = {
  key: 'workers_overview',
  measurement: 'cf_workers_overview',
  field: 'workersOverviewRequestsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'status', 'usageModel'],
  blocks: { sum: ['cpuTimeUs'] },
  tags: [
    { source: 'status', as: 'status' },
    { source: 'usageModel', as: 'usage_model' },
  ],
  fields: {
    cpu_time_us: { type: 'int', source: ['sum', 'cpuTimeUs'] },
  },
};

export const D1_QUERIES: DatasetQuery = {
  key: 'd1_queries',
  measurement: 'cf_d1_queries',
  field: 'd1AnalyticsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'databaseId', 'databaseRole'],
  blocks: {
    sum: ['readQueries', 'writeQueries', 'rowsRead', 'rowsWritten', 'queryBatchResponseBytes'],
    avg: ['queryBatchTimeMs', 'queryBatchResponseBytes', 'sampleInterval'],
  },
  tags: [
    { source: 'databaseId', as: 'database_id' },
    { source: 'databaseRole', as: 'database_role' },
  ],
  fields: {
    read_queries: { type: 'int', source: ['sum', 'readQueries'] },
    write_queries: { type: 'int', source: ['sum', 'writeQueries'] },
    rows_read: { type: 'int', source: ['sum', 'rowsRead'] },
    rows_written: { type: 'int', source: ['sum', 'rowsWritten'] },
    response_bytes_sum: { type: 'int', source: ['sum', 'queryBatchResponseBytes'] },
    query_duration_ms_avg: { type: 'float', source: ['avg', 'queryBatchTimeMs'] },
    response_bytes_avg: { type: 'float', source: ['avg', 'queryBatchResponseBytes'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

export const D1_STORAGE: DatasetQuery = {
  key: 'd1_storage',
  measurement: 'cf_d1_storage',
  field: 'd1StorageAdaptiveGroups',
  dimensions: ['datetimeMinute', 'databaseId'],
  blocks: { max: ['databaseSizeBytes'] },
  tags: [{ source: 'databaseId', as: 'database_id' }],
  fields: {
    database_size_bytes: { type: 'int', source: ['max', 'databaseSizeBytes'] },
  },
};

export const R2_OPERATIONS: DatasetQuery = {
  key: 'r2_operations',
  measurement: 'cf_r2_operations',
  field: 'r2OperationsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'bucketName', 'actionType', 'actionStatus', 'responseStatusCode', 'storageClass'],
  blocks: {
    sum: ['requests', 'responseBytes', 'responseObjectSize'],
  },
  tags: [
    { source: 'bucketName', as: 'bucket_name' },
    { source: 'actionType', as: 'action_type' },
    { source: 'actionStatus', as: 'action_status' },
    { source: 'responseStatusCode', as: 'response_status_code' },
    { source: 'storageClass', as: 'storage_class' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    response_bytes: { type: 'int', source: ['sum', 'responseBytes'] },
    response_object_bytes: { type: 'int', source: ['sum', 'responseObjectSize'] },
  },
};

export const R2_STORAGE: DatasetQuery = {
  key: 'r2_storage',
  measurement: 'cf_r2_storage',
  field: 'r2StorageAdaptiveGroups',
  dimensions: ['datetimeMinute', 'bucketName', 'storageClass'],
  blocks: { max: ['objectCount', 'payloadSize', 'metadataSize', 'uploadCount'] },
  tags: [
    { source: 'bucketName', as: 'bucket_name' },
    { source: 'storageClass', as: 'storage_class' },
  ],
  fields: {
    object_count: { type: 'int', source: ['max', 'objectCount'] },
    payload_bytes: { type: 'int', source: ['max', 'payloadSize'] },
    metadata_bytes: { type: 'int', source: ['max', 'metadataSize'] },
    upload_count: { type: 'int', source: ['max', 'uploadCount'] },
  },
};

export const KV_OPERATIONS: DatasetQuery = {
  key: 'kv_operations',
  measurement: 'cf_kv_operations',
  field: 'kvOperationsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'namespaceId', 'actionType', 'result', 'responseStatusCode'],
  blocks: { sum: ['requests', 'objectBytes'] },
  tags: [
    { source: 'namespaceId', as: 'namespace_id' },
    { source: 'actionType', as: 'action_type' },
    { source: 'result', as: 'result' },
    { source: 'responseStatusCode', as: 'response_status_code' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    object_bytes: { type: 'int', source: ['sum', 'objectBytes'] },
  },
};

export const KV_STORAGE: DatasetQuery = {
  key: 'kv_storage',
  measurement: 'cf_kv_storage',
  field: 'kvStorageAdaptiveGroups',
  dimensions: ['datetimeMinute', 'namespaceId'],
  blocks: { max: ['byteCount', 'keyCount'] },
  tags: [{ source: 'namespaceId', as: 'namespace_id' }],
  fields: {
    byte_count: { type: 'int', source: ['max', 'byteCount'] },
    key_count: { type: 'int', source: ['max', 'keyCount'] },
  },
};

export const DURABLE_OBJECTS_INVOCATIONS: DatasetQuery = {
  key: 'durable_objects_invocations',
  measurement: 'cf_durable_objects_invocations',
  field: 'durableObjectsInvocationsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'namespaceId', 'scriptName', 'status', 'type'],
  blocks: {
    sum: ['requests', 'errors', 'responseBodySize', 'wallTime'],
    max: ['wallTime', 'responseBodySize'],
  },
  tags: [
    { source: 'namespaceId', as: 'namespace_id' },
    { source: 'scriptName', as: 'script_name' },
    { source: 'status', as: 'status' },
    { source: 'type', as: 'type' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    errors: { type: 'int', source: ['sum', 'errors'] },
    response_body_size_bytes_sum: { type: 'int', source: ['sum', 'responseBodySize'] },
    wall_time_us_sum: { type: 'int', source: ['sum', 'wallTime'] },
    wall_time_us_max: { type: 'int', source: ['max', 'wallTime'] },
    response_body_size_bytes_max: { type: 'int', source: ['max', 'responseBodySize'] },
  },
};

export const DURABLE_OBJECTS_PERIODIC: DatasetQuery = {
  key: 'durable_objects_periodic',
  measurement: 'cf_durable_objects_periodic',
  field: 'durableObjectsPeriodicGroups',
  dimensions: ['datetimeMinute', 'namespaceId'],
  blocks: {
    sum: [
      'activeTime',
      'cpuTime',
      'duration',
      'exceededCpuErrors',
      'exceededMemoryErrors',
      'fatalInternalErrors',
      'inboundWebsocketMsgCount',
      'outboundWebsocketMsgCount',
      'rowsRead',
      'rowsWritten',
      'storageDeletes',
      'storageReadUnits',
      'storageWriteUnits',
      'subrequests',
    ],
    max: ['activeWebsocketConnections'],
  },
  tags: [{ source: 'namespaceId', as: 'namespace_id' }],
  fields: {
    active_time_us: { type: 'int', source: ['sum', 'activeTime'] },
    cpu_time_us: { type: 'int', source: ['sum', 'cpuTime'] },
    duration_ms: { type: 'float', source: ['sum', 'duration'], scale: 1000 },
    exceeded_cpu_errors: { type: 'int', source: ['sum', 'exceededCpuErrors'] },
    exceeded_memory_errors: { type: 'int', source: ['sum', 'exceededMemoryErrors'] },
    fatal_internal_errors: { type: 'int', source: ['sum', 'fatalInternalErrors'] },
    inbound_ws_messages: { type: 'int', source: ['sum', 'inboundWebsocketMsgCount'] },
    outbound_ws_messages: { type: 'int', source: ['sum', 'outboundWebsocketMsgCount'] },
    rows_read: { type: 'int', source: ['sum', 'rowsRead'] },
    rows_written: { type: 'int', source: ['sum', 'rowsWritten'] },
    storage_deletes: { type: 'int', source: ['sum', 'storageDeletes'] },
    storage_read_units: { type: 'int', source: ['sum', 'storageReadUnits'] },
    storage_write_units: { type: 'int', source: ['sum', 'storageWriteUnits'] },
    subrequests: { type: 'int', source: ['sum', 'subrequests'] },
    active_ws_connections_max: { type: 'int', source: ['max', 'activeWebsocketConnections'] },
  },
};

export const DURABLE_OBJECTS_STORAGE: DatasetQuery = {
  key: 'durable_objects_storage',
  measurement: 'cf_durable_objects_storage',
  field: 'durableObjectsStorageGroups',
  dimensions: ['datetimeMinute'],
  filterGranularity: 'date',
  blocks: { max: ['storedBytes'] },
  tags: [],
  fields: {
    stored_bytes: { type: 'int', source: ['max', 'storedBytes'] },
  },
};

export const DURABLE_OBJECTS_SQL_STORAGE: DatasetQuery = {
  key: 'durable_objects_sql_storage',
  measurement: 'cf_durable_objects_sql_storage',
  field: 'durableObjectsSqlStorageGroups',
  dimensions: ['datetimeMinute', 'namespaceId'],
  filterGranularity: 'date',
  blocks: { max: ['storedBytes'] },
  tags: [{ source: 'namespaceId', as: 'namespace_id' }],
  fields: {
    stored_bytes: { type: 'int', source: ['max', 'storedBytes'] },
  },
};

export const DURABLE_OBJECTS_SUBREQUESTS: DatasetQuery = {
  key: 'durable_objects_subrequests',
  measurement: 'cf_durable_objects_subrequests',
  field: 'durableObjectsSubrequestsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'namespaceId', 'scriptName'],
  blocks: { sum: ['requestBodySizeUncached'] },
  tags: [
    { source: 'namespaceId', as: 'namespace_id' },
    { source: 'scriptName', as: 'script_name' },
  ],
  fields: {
    request_body_size_uncached_bytes: { type: 'int', source: ['sum', 'requestBodySizeUncached'] },
  },
};

export const QUEUE_OPERATIONS: DatasetQuery = {
  key: 'queue_operations',
  measurement: 'cf_queue_operations',
  field: 'queueMessageOperationsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'queueId', 'actionType', 'consumerType', 'outcome'],
  blocks: { sum: ['billableOperations', 'bytes'] },
  tags: [
    { source: 'queueId', as: 'queue_id' },
    { source: 'actionType', as: 'action_type' },
    { source: 'consumerType', as: 'consumer_type' },
    { source: 'outcome', as: 'outcome' },
  ],
  fields: {
    billable_operations: { type: 'int', source: ['sum', 'billableOperations'] },
    bytes: { type: 'int', source: ['sum', 'bytes'] },
  },
};

export const QUEUE_BACKLOG: DatasetQuery = {
  key: 'queue_backlog',
  measurement: 'cf_queue_backlog',
  field: 'queueBacklogAdaptiveGroups',
  dimensions: ['datetimeMinute', 'queueId'],
  blocks: { avg: ['bytes', 'messages', 'sampleInterval'] },
  tags: [{ source: 'queueId', as: 'queue_id' }],
  fields: {
    backlog_bytes_avg: { type: 'float', source: ['avg', 'bytes'] },
    backlog_messages_avg: { type: 'float', source: ['avg', 'messages'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

export const HYPERDRIVE_QUERIES: DatasetQuery = {
  key: 'hyperdrive_queries',
  measurement: 'cf_hyperdrive_queries',
  field: 'hyperdriveQueriesAdaptiveGroups',
  dimensions: ['datetimeMinute', 'configId', 'cacheStatus', 'eventStatus', 'isFree'],
  blocks: {
    sum: [
      'queryBytes',
      'resultBytes',
      'queryLatency',
      'connectionLatency',
      'originReadLatency',
      'originWriteLatency',
      'clientWriteLatency',
    ],
  },
  tags: [
    { source: 'configId', as: 'config_id' },
    { source: 'cacheStatus', as: 'cache_status' },
    { source: 'eventStatus', as: 'event_status' },
    { source: 'isFree', as: 'is_free' },
  ],
  fields: {
    query_bytes: { type: 'int', source: ['sum', 'queryBytes'] },
    result_bytes: { type: 'int', source: ['sum', 'resultBytes'] },
    query_latency_us: { type: 'int', source: ['sum', 'queryLatency'] },
    connection_latency_us: { type: 'int', source: ['sum', 'connectionLatency'] },
    origin_read_latency_us: { type: 'int', source: ['sum', 'originReadLatency'] },
    origin_write_latency_us: { type: 'int', source: ['sum', 'originWriteLatency'] },
    client_write_latency_us: { type: 'int', source: ['sum', 'clientWriteLatency'] },
  },
};

export const HYPERDRIVE_POOL: DatasetQuery = {
  key: 'hyperdrive_pool',
  measurement: 'cf_hyperdrive_pool',
  field: 'hyperdrivePoolSizesAdaptiveGroups',
  dimensions: ['datetimeMinute', 'configId', 'databaseType'],
  blocks: { max: ['currentPoolSize', 'maxPoolSize', 'waitingClients'] },
  tags: [
    { source: 'configId', as: 'config_id' },
    { source: 'databaseType', as: 'database_type' },
  ],
  fields: {
    current_pool_size: { type: 'int', source: ['max', 'currentPoolSize'] },
    max_pool_size: { type: 'int', source: ['max', 'maxPoolSize'] },
    waiting_clients: { type: 'int', source: ['max', 'waitingClients'] },
  },
};

export const HTTP_REQUESTS_OVERVIEW: DatasetQuery = {
  key: 'http_requests_overview',
  measurement: 'cf_http_requests_overview',
  field: 'httpRequestsOverviewAdaptiveGroups',
  dimensions: ['datetimeMinute', 'zoneTag', 'clientCountryName', 'clientRequestHTTPProtocol', 'edgeResponseStatus'],
  blocks: { sum: ['requests', 'bytes', 'cachedRequests', 'cachedBytes', 'pageViews', 'visits'] },
  tags: [
    { source: 'zoneTag', as: 'zone_tag' },
    { source: 'clientCountryName', as: 'client_country' },
    { source: 'clientRequestHTTPProtocol', as: 'http_protocol' },
    { source: 'edgeResponseStatus', as: 'edge_response_status' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    bytes: { type: 'int', source: ['sum', 'bytes'] },
    cached_requests: { type: 'int', source: ['sum', 'cachedRequests'] },
    cached_bytes: { type: 'int', source: ['sum', 'cachedBytes'] },
    page_views: { type: 'int', source: ['sum', 'pageViews'] },
    visits: { type: 'int', source: ['sum', 'visits'] },
  },
};

export const PAGES_FUNCTIONS_INVOCATIONS: DatasetQuery = {
  key: 'pages_functions_invocations',
  measurement: 'cf_pages_functions_invocations',
  field: 'pagesFunctionsInvocationsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'scriptName', 'status', 'usageModel'],
  blocks: {
    sum: ['requests', 'errors', 'clientDisconnects', 'duration', 'wallTime', 'subrequests', 'responseBodySize'],
  },
  tags: [
    { source: 'scriptName', as: 'script_name' },
    { source: 'status', as: 'status' },
    { source: 'usageModel', as: 'usage_model' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    errors: { type: 'int', source: ['sum', 'errors'] },
    client_disconnects: { type: 'int', source: ['sum', 'clientDisconnects'] },
    duration_ms_sum: { type: 'float', source: ['sum', 'duration'], scale: 1000 },
    wall_time_us_sum: { type: 'int', source: ['sum', 'wallTime'] },
    subrequests: { type: 'int', source: ['sum', 'subrequests'] },
    response_body_size_bytes_sum: { type: 'int', source: ['sum', 'responseBodySize'] },
  },
};

export const D1_QUERIES_DETAIL: DatasetQuery = {
  key: 'd1_queries_detail',
  measurement: 'cf_d1_queries_detail',
  field: 'd1QueriesAdaptiveGroups',
  dimensions: ['datetimeMinute', 'databaseId', 'databaseRole', 'error'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['queryDurationMs', 'rowsRead', 'rowsReturned', 'rowsWritten'],
    avg: ['queryDurationMs', 'sampleInterval'],
    quantiles: ['queryDurationMsP50', 'queryDurationMsP95', 'queryDurationMsP99'],
  },
  tags: [
    { source: 'databaseId', as: 'database_id' },
    { source: 'databaseRole', as: 'database_role' },
    { source: 'error', as: 'error' },
  ],
  fields: {
    query_count: { type: 'int', source: ['_top', 'count'] },
    query_duration_ms_sum: { type: 'float', source: ['sum', 'queryDurationMs'] },
    rows_read: { type: 'int', source: ['sum', 'rowsRead'] },
    rows_returned: { type: 'int', source: ['sum', 'rowsReturned'] },
    rows_written: { type: 'int', source: ['sum', 'rowsWritten'] },
    query_duration_ms_avg: { type: 'float', source: ['avg', 'queryDurationMs'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
    query_duration_ms_p50: { type: 'float', source: ['quantiles', 'queryDurationMsP50'] },
    query_duration_ms_p95: { type: 'float', source: ['quantiles', 'queryDurationMsP95'] },
    query_duration_ms_p99: { type: 'float', source: ['quantiles', 'queryDurationMsP99'] },
  },
};

export const QUEUE_CONSUMER: DatasetQuery = {
  key: 'queue_consumer',
  measurement: 'cf_queue_consumer',
  field: 'queueConsumerMetricsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'queueId'],
  blocks: { avg: ['concurrency', 'sampleInterval'] },
  tags: [{ source: 'queueId', as: 'queue_id' }],
  fields: {
    concurrency_avg: { type: 'float', source: ['avg', 'concurrency'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

// Note: `firewallEventsAdaptiveGroups` is gated on Business/Enterprise plans and
// returns `authz`/"does not have access to the path" on free/Pro accounts. We
// leave it out of the registry rather than failing loudly every cron tick —
// if the plan level changes, adding an entry here with
// `scope: 'zone', field: 'firewallEventsAdaptiveGroups'` will be enough.

export const HTTP_REQUESTS_DETAIL: DatasetQuery = {
  key: 'http_requests_detail',
  measurement: 'cf_http_requests_detail',
  field: 'httpRequestsAdaptiveGroups',
  // `httpRequestsAdaptiveGroups` is gated at the account level on non-Enterprise
  // plans but works at the zone level. The collector iterates over the cached
  // zones (bulk list + Pages lookups) and runs one query per zone.
  scope: 'zone',
  dimensions: [
    'datetimeMinute',
    'clientCountryName',
    'clientRequestHTTPMethodName',
    'clientRequestHTTPProtocol',
    'edgeResponseStatus',
    'cacheStatus',
  ],
  topLevelFields: ['count'],
  blocks: {
    sum: [
      'edgeRequestBytes',
      'edgeResponseBytes',
      'visits',
      'crossZoneSubrequests',
      'edgeTimeToFirstByteMs',
      'originResponseDurationMs',
    ],
    avg: ['edgeTimeToFirstByteMs', 'originResponseDurationMs', 'sampleInterval'],
  },
  tags: [
    { source: 'clientCountryName', as: 'client_country' },
    { source: 'clientRequestHTTPMethodName', as: 'http_method' },
    { source: 'clientRequestHTTPProtocol', as: 'http_protocol' },
    { source: 'edgeResponseStatus', as: 'edge_response_status' },
    { source: 'cacheStatus', as: 'cache_status' },
  ],
  fields: {
    requests: { type: 'int', source: ['_top', 'count'] },
    edge_request_bytes: { type: 'int', source: ['sum', 'edgeRequestBytes'] },
    edge_response_bytes: { type: 'int', source: ['sum', 'edgeResponseBytes'] },
    visits: { type: 'int', source: ['sum', 'visits'] },
    cross_zone_subrequests: { type: 'int', source: ['sum', 'crossZoneSubrequests'] },
    edge_ttfb_ms_sum: { type: 'float', source: ['sum', 'edgeTimeToFirstByteMs'] },
    origin_response_ms_sum: { type: 'float', source: ['sum', 'originResponseDurationMs'] },
    edge_ttfb_ms_avg: { type: 'float', source: ['avg', 'edgeTimeToFirstByteMs'] },
    origin_response_ms_avg: { type: 'float', source: ['avg', 'originResponseDurationMs'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

// =============================================================================
// Additional account-level datasets. These cover products the account may or
// may not currently be using — dimensions are picked conservatively to keep
// cardinality manageable, and datasets with no current data just return zero
// rows and no-op.
// =============================================================================

export const WORKERS_ANALYTICS_ENGINE: DatasetQuery = {
  key: 'workers_analytics_engine',
  measurement: 'cf_workers_analytics_engine',
  field: 'workersAnalyticsEngineAdaptiveGroups',
  dimensions: ['datetimeMinute', 'dataset'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [{ source: 'dataset', as: 'dataset' }],
  fields: { events: { type: 'int', source: ['_top', 'count'] } },
};

export const WORKERS_BUILDS: DatasetQuery = {
  key: 'workers_builds',
  measurement: 'cf_workers_builds',
  field: 'workersBuildsBuildMinutesAdaptiveGroups',
  dimensions: ['datetimeMinute'],
  blocks: { sum: ['buildMinutes'] },
  tags: [],
  fields: { build_minutes: { type: 'float', source: ['sum', 'buildMinutes'] } },
};

export const WORKERS_VPC: DatasetQuery = {
  key: 'workers_vpc',
  measurement: 'cf_workers_vpc',
  field: 'workersVpcConnectionAdaptiveGroups',
  dimensions: ['datetimeMinute', 'targetId', 'status', 'errorCode'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['connectionLatency', 'dnsLatency'],
    avg: ['connectionLatency', 'dnsLatency'],
  },
  tags: [
    { source: 'targetId', as: 'target_id' },
    { source: 'status', as: 'status' },
    { source: 'errorCode', as: 'error_code' },
  ],
  fields: {
    connections: { type: 'int', source: ['_top', 'count'] },
    connection_latency_ms_sum: { type: 'float', source: ['sum', 'connectionLatency'] },
    dns_latency_ms_sum: { type: 'float', source: ['sum', 'dnsLatency'] },
    connection_latency_ms_avg: { type: 'float', source: ['avg', 'connectionLatency'] },
    dns_latency_ms_avg: { type: 'float', source: ['avg', 'dnsLatency'] },
  },
};

export const WORKER_PLACEMENT: DatasetQuery = {
  key: 'worker_placement',
  measurement: 'cf_worker_placement',
  field: 'workerPlacementAdaptiveGroups',
  dimensions: ['datetimeMinute', 'scriptName', 'placementUsed', 'httpStatus'],
  blocks: {
    sum: ['requests', 'requestDuration'],
    quantiles: ['requestDurationP50', 'requestDurationP95', 'requestDurationP99'],
  },
  tags: [
    { source: 'scriptName', as: 'script_name' },
    { source: 'placementUsed', as: 'placement_used' },
    { source: 'httpStatus', as: 'http_status' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    request_duration_ms_sum: { type: 'float', source: ['sum', 'requestDuration'] },
    request_duration_ms_p50: { type: 'float', source: ['quantiles', 'requestDurationP50'] },
    request_duration_ms_p95: { type: 'float', source: ['quantiles', 'requestDurationP95'] },
    request_duration_ms_p99: { type: 'float', source: ['quantiles', 'requestDurationP99'] },
  },
};

export const WORKFLOWS: DatasetQuery = {
  key: 'workflows',
  measurement: 'cf_workflows',
  field: 'workflowsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'workflowName', 'eventType'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['allStepCount', 'cpuTime', 'executionDuration', 'retryCount', 'stepCount', 'storageRate', 'wallTime'],
    avg: ['cpuTime', 'wallTime'],
  },
  tags: [
    { source: 'workflowName', as: 'workflow_name' },
    { source: 'eventType', as: 'event_type' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    all_steps: { type: 'int', source: ['sum', 'allStepCount'] },
    cpu_time_us_sum: { type: 'int', source: ['sum', 'cpuTime'] },
    execution_duration_ms_sum: { type: 'float', source: ['sum', 'executionDuration'] },
    retries: { type: 'int', source: ['sum', 'retryCount'] },
    steps: { type: 'int', source: ['sum', 'stepCount'] },
    storage_rate: { type: 'float', source: ['sum', 'storageRate'] },
    wall_time_us_sum: { type: 'int', source: ['sum', 'wallTime'] },
    cpu_time_us_avg: { type: 'int', source: ['avg', 'cpuTime'] },
    wall_time_us_avg: { type: 'int', source: ['avg', 'wallTime'] },
  },
};

export const AI_GATEWAY_REQUESTS: DatasetQuery = {
  key: 'ai_gateway_requests',
  measurement: 'cf_ai_gateway_requests',
  field: 'aiGatewayRequestsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'gateway', 'provider', 'model', 'cached', 'error', 'rateLimited'],
  topLevelFields: ['count'],
  blocks: {
    sum: [
      'cachedRequests',
      'cachedTokensIn',
      'cachedTokensOut',
      'cost',
      'erroredRequests',
      'uncachedTokensIn',
      'uncachedTokensOut',
    ],
  },
  tags: [
    { source: 'gateway', as: 'gateway' },
    { source: 'provider', as: 'provider' },
    { source: 'model', as: 'model' },
    { source: 'cached', as: 'cached' },
    { source: 'error', as: 'error' },
    { source: 'rateLimited', as: 'rate_limited' },
  ],
  fields: {
    requests: { type: 'int', source: ['_top', 'count'] },
    cached_requests: { type: 'int', source: ['sum', 'cachedRequests'] },
    cached_tokens_in: { type: 'int', source: ['sum', 'cachedTokensIn'] },
    cached_tokens_out: { type: 'int', source: ['sum', 'cachedTokensOut'] },
    cost: { type: 'float', source: ['sum', 'cost'] },
    errored_requests: { type: 'int', source: ['sum', 'erroredRequests'] },
    uncached_tokens_in: { type: 'int', source: ['sum', 'uncachedTokensIn'] },
    uncached_tokens_out: { type: 'int', source: ['sum', 'uncachedTokensOut'] },
  },
};

export const AI_GATEWAY_CACHE: DatasetQuery = {
  key: 'ai_gateway_cache',
  measurement: 'cf_ai_gateway_cache',
  field: 'aiGatewayCacheAdaptiveGroups',
  dimensions: ['datetimeMinute', 'gateway', 'provider', 'model', 'cacheOp'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'gateway', as: 'gateway' },
    { source: 'provider', as: 'provider' },
    { source: 'model', as: 'model' },
    { source: 'cacheOp', as: 'cache_op' },
  ],
  fields: { events: { type: 'int', source: ['_top', 'count'] } },
};

export const AI_GATEWAY_ERRORS: DatasetQuery = {
  key: 'ai_gateway_errors',
  measurement: 'cf_ai_gateway_errors',
  field: 'aiGatewayErrorsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'gateway', 'provider', 'model'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'gateway', as: 'gateway' },
    { source: 'provider', as: 'provider' },
    { source: 'model', as: 'model' },
  ],
  fields: { errors: { type: 'int', source: ['_top', 'count'] } },
};

export const AI_GATEWAY_SIZE: DatasetQuery = {
  key: 'ai_gateway_size',
  measurement: 'cf_ai_gateway_size',
  field: 'aiGatewaySizeAdaptiveGroups',
  dimensions: ['datetimeMinute', 'gateway', 'logManagement'],
  blocks: { max: ['rows'] },
  tags: [
    { source: 'gateway', as: 'gateway' },
    { source: 'logManagement', as: 'log_management' },
  ],
  fields: { rows_max: { type: 'int', source: ['max', 'rows'] } },
};

export const AI_INFERENCE: DatasetQuery = {
  key: 'ai_inference',
  measurement: 'cf_ai_inference',
  field: 'aiInferenceAdaptiveGroups',
  dimensions: ['datetimeMinute', 'modelId', 'errorCode', 'requestSource', 'tag'],
  topLevelFields: ['count'],
  blocks: {
    sum: [
      'totalAudioSeconds',
      'totalInferenceSteps',
      'totalInferenceTimeMs',
      'totalInputLength',
      'totalInputTokens',
      'totalNeurons',
      'totalOutputTokens',
      'totalProcessedPixels',
      'totalProcessedTiles',
      'totalRequestBytesIn',
      'totalRequestBytesOut',
      'totalTiles',
    ],
  },
  tags: [
    { source: 'modelId', as: 'model_id' },
    { source: 'errorCode', as: 'error_code' },
    { source: 'requestSource', as: 'request_source' },
    { source: 'tag', as: 'tag' },
  ],
  fields: {
    requests: { type: 'int', source: ['_top', 'count'] },
    audio_seconds: { type: 'float', source: ['sum', 'totalAudioSeconds'] },
    inference_steps: { type: 'int', source: ['sum', 'totalInferenceSteps'] },
    inference_time_ms: { type: 'float', source: ['sum', 'totalInferenceTimeMs'] },
    input_length: { type: 'int', source: ['sum', 'totalInputLength'] },
    input_tokens: { type: 'int', source: ['sum', 'totalInputTokens'] },
    neurons: { type: 'int', source: ['sum', 'totalNeurons'] },
    output_tokens: { type: 'int', source: ['sum', 'totalOutputTokens'] },
    processed_pixels: { type: 'int', source: ['sum', 'totalProcessedPixels'] },
    processed_tiles: { type: 'int', source: ['sum', 'totalProcessedTiles'] },
    request_bytes_in: { type: 'int', source: ['sum', 'totalRequestBytesIn'] },
    request_bytes_out: { type: 'int', source: ['sum', 'totalRequestBytesOut'] },
    tiles: { type: 'int', source: ['sum', 'totalTiles'] },
  },
};

export const AI_SEARCH_API: DatasetQuery = {
  key: 'ai_search_api',
  measurement: 'cf_ai_search_api',
  field: 'aiSearchAPIAdaptiveGroups',
  dimensions: ['datetimeMinute', 'searchType', 'aiSearchModel'],
  topLevelFields: ['count'],
  blocks: { sum: ['aiSearchCount', 'searchCount'] },
  tags: [
    { source: 'searchType', as: 'search_type' },
    { source: 'aiSearchModel', as: 'ai_search_model' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    ai_search_count: { type: 'int', source: ['sum', 'aiSearchCount'] },
    search_count: { type: 'int', source: ['sum', 'searchCount'] },
  },
};

export const AI_SEARCH_INGESTED_ITEMS: DatasetQuery = {
  key: 'ai_search_ingested',
  measurement: 'cf_ai_search_ingested',
  field: 'aiSearchIngestedItemsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'indexId', 'embeddingModel', 'error'],
  topLevelFields: ['count'],
  blocks: {
    sum: [
      'chunkingDurationMs',
      'embeddingDurationMs',
      'fileSizeBytes',
      'numChunks',
      'totalDurationMs',
      'totalTokens',
      'vectorizeDurationMs',
    ],
    avg: ['fileSizeBytes', 'numChunks'],
  },
  tags: [
    { source: 'indexId', as: 'index_id' },
    { source: 'embeddingModel', as: 'embedding_model' },
    { source: 'error', as: 'error' },
  ],
  fields: {
    items: { type: 'int', source: ['_top', 'count'] },
    chunking_duration_ms: { type: 'float', source: ['sum', 'chunkingDurationMs'] },
    embedding_duration_ms: { type: 'float', source: ['sum', 'embeddingDurationMs'] },
    file_size_bytes: { type: 'int', source: ['sum', 'fileSizeBytes'] },
    num_chunks: { type: 'int', source: ['sum', 'numChunks'] },
    total_duration_ms: { type: 'float', source: ['sum', 'totalDurationMs'] },
    total_tokens: { type: 'int', source: ['sum', 'totalTokens'] },
    vectorize_duration_ms: { type: 'float', source: ['sum', 'vectorizeDurationMs'] },
    avg_file_size_bytes: { type: 'float', source: ['avg', 'fileSizeBytes'] },
    avg_num_chunks: { type: 'float', source: ['avg', 'numChunks'] },
  },
};

export const AUTO_RAG_CONFIG_API: DatasetQuery = {
  key: 'auto_rag_config_api',
  measurement: 'cf_auto_rag_config_api',
  field: 'autoRAGConfigAPIAdaptiveGroups',
  dimensions: ['datetimeMinute', 'rag', 'searchType'],
  blocks: { sum: ['aiSearchCount', 'searchCount'] },
  tags: [
    { source: 'rag', as: 'rag' },
    { source: 'searchType', as: 'search_type' },
  ],
  fields: {
    ai_search_count: { type: 'int', source: ['sum', 'aiSearchCount'] },
    search_count: { type: 'int', source: ['sum', 'searchCount'] },
  },
};

export const AUTO_RAG_ENGINE: DatasetQuery = {
  key: 'auto_rag_engine',
  measurement: 'cf_auto_rag_engine',
  field: 'autoRAGEngineAdaptiveGroups',
  dimensions: ['datetimeMinute', 'rag', 'sourceType'],
  blocks: { max: ['completed', 'errored', 'queued', 'running'] },
  tags: [
    { source: 'rag', as: 'rag' },
    { source: 'sourceType', as: 'source_type' },
  ],
  fields: {
    completed_max: { type: 'int', source: ['max', 'completed'] },
    errored_max: { type: 'int', source: ['max', 'errored'] },
    queued_max: { type: 'int', source: ['max', 'queued'] },
    running_max: { type: 'int', source: ['max', 'running'] },
  },
};

export const VECTORIZE_OPERATIONS: DatasetQuery = {
  key: 'vectorize_operations',
  measurement: 'cf_vectorize_operations',
  field: 'vectorizeV2OperationsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'indexName', 'operation', 'requestStatus'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'indexName', as: 'index_name' },
    { source: 'operation', as: 'operation' },
    { source: 'requestStatus', as: 'request_status' },
  ],
  fields: { operations: { type: 'int', source: ['_top', 'count'] } },
};

export const VECTORIZE_QUERIES: DatasetQuery = {
  key: 'vectorize_queries',
  measurement: 'cf_vectorize_queries',
  field: 'vectorizeV2QueriesAdaptiveGroups',
  dimensions: ['datetimeMinute', 'indexName', 'operation', 'requestStatus'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['queriedVectorDimensions', 'requestDurationMs', 'servedVectorCount'],
    avg: ['requestDurationMs'],
    quantiles: ['requestDurationMsP50', 'requestDurationMsP95', 'requestDurationMsP99'],
  },
  tags: [
    { source: 'indexName', as: 'index_name' },
    { source: 'operation', as: 'operation' },
    { source: 'requestStatus', as: 'request_status' },
  ],
  fields: {
    queries: { type: 'int', source: ['_top', 'count'] },
    queried_vector_dimensions: { type: 'int', source: ['sum', 'queriedVectorDimensions'] },
    request_duration_ms_sum: { type: 'float', source: ['sum', 'requestDurationMs'] },
    served_vectors: { type: 'int', source: ['sum', 'servedVectorCount'] },
    request_duration_ms_avg: { type: 'float', source: ['avg', 'requestDurationMs'] },
    request_duration_ms_p50: { type: 'float', source: ['quantiles', 'requestDurationMsP50'] },
    request_duration_ms_p95: { type: 'float', source: ['quantiles', 'requestDurationMsP95'] },
    request_duration_ms_p99: { type: 'float', source: ['quantiles', 'requestDurationMsP99'] },
  },
};

export const VECTORIZE_STORAGE: DatasetQuery = {
  key: 'vectorize_storage',
  measurement: 'cf_vectorize_storage',
  field: 'vectorizeV2StorageAdaptiveGroups',
  dimensions: ['datetimeMinute', 'indexName'],
  blocks: { max: ['storedVectorDimensions', 'vectorCount'] },
  tags: [{ source: 'indexName', as: 'index_name' }],
  fields: {
    stored_vector_dimensions: { type: 'int', source: ['max', 'storedVectorDimensions'] },
    vector_count: { type: 'int', source: ['max', 'vectorCount'] },
  },
};

export const VECTORIZE_WRITES: DatasetQuery = {
  key: 'vectorize_writes',
  measurement: 'cf_vectorize_writes',
  field: 'vectorizeV2WritesAdaptiveGroups',
  dimensions: ['datetimeMinute', 'indexName', 'operation', 'requestStatus'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['addedVectorCount', 'deletedVectorCount', 'requestDurationMs'],
    avg: ['requestDurationMs'],
    quantiles: ['requestDurationMsP50', 'requestDurationMsP95', 'requestDurationMsP99'],
  },
  tags: [
    { source: 'indexName', as: 'index_name' },
    { source: 'operation', as: 'operation' },
    { source: 'requestStatus', as: 'request_status' },
  ],
  fields: {
    writes: { type: 'int', source: ['_top', 'count'] },
    added_vectors: { type: 'int', source: ['sum', 'addedVectorCount'] },
    deleted_vectors: { type: 'int', source: ['sum', 'deletedVectorCount'] },
    request_duration_ms_sum: { type: 'float', source: ['sum', 'requestDurationMs'] },
    request_duration_ms_avg: { type: 'float', source: ['avg', 'requestDurationMs'] },
    request_duration_ms_p50: { type: 'float', source: ['quantiles', 'requestDurationMsP50'] },
    request_duration_ms_p95: { type: 'float', source: ['quantiles', 'requestDurationMsP95'] },
    request_duration_ms_p99: { type: 'float', source: ['quantiles', 'requestDurationMsP99'] },
  },
};

export const BROWSER_RENDERING_API: DatasetQuery = {
  key: 'browser_rendering_api',
  measurement: 'cf_browser_rendering_api',
  field: 'browserRenderingApiAdaptiveGroups',
  dimensions: ['datetimeMinute', 'endpoint', 'status'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'endpoint', as: 'endpoint' },
    { source: 'status', as: 'status' },
  ],
  fields: { requests: { type: 'int', source: ['_top', 'count'] } },
};

export const BROWSER_RENDERING_BINDING_SESSIONS: DatasetQuery = {
  key: 'browser_rendering_binding_sessions',
  measurement: 'cf_browser_rendering_binding_sessions',
  field: 'browserRenderingBindingSessionsAdaptiveGroups',
  dimensions: ['datetimeMinute'],
  topLevelFields: ['count'],
  blocks: {
    avg: ['avgConcurrentSessions'],
    max: ['maxConcurrentSessions'],
    uniq: ['sessionIdCount'],
  },
  tags: [],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    avg_concurrent_sessions: { type: 'float', source: ['avg', 'avgConcurrentSessions'] },
    max_concurrent_sessions: { type: 'int', source: ['max', 'maxConcurrentSessions'] },
    unique_sessions: { type: 'int', source: ['uniq', 'sessionIdCount'] },
  },
};

export const BROWSER_RENDERING_BROWSER_TIME: DatasetQuery = {
  key: 'browser_rendering_browser_time',
  measurement: 'cf_browser_rendering_browser_time',
  field: 'browserRenderingBrowserTimeUsageAdaptiveGroups',
  dimensions: ['datetimeMinute'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['totalSessionDurationMs'],
    avg: ['avgSessionDurationMs'],
    max: ['maxSessionDurationMs'],
    min: ['minSessionDurationMs'],
  },
  tags: [],
  fields: {
    sessions: { type: 'int', source: ['_top', 'count'] },
    total_session_duration_ms: { type: 'float', source: ['sum', 'totalSessionDurationMs'] },
    avg_session_duration_ms: { type: 'float', source: ['avg', 'avgSessionDurationMs'] },
    max_session_duration_ms: { type: 'float', source: ['max', 'maxSessionDurationMs'] },
    min_session_duration_ms: { type: 'float', source: ['min', 'minSessionDurationMs'] },
  },
};

export const BROWSER_RENDERING_EVENTS: DatasetQuery = {
  key: 'browser_rendering_events',
  measurement: 'cf_browser_rendering_events',
  field: 'browserRenderingEventsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'scriptName', 'browserCloseReason', 'clientLibrary', 'recordingMode'],
  topLevelFields: ['count'],
  blocks: {
    avg: ['avgConcurrentSessions'],
    uniq: ['connectionIdCount', 'sessionIdCount'],
  },
  tags: [
    { source: 'scriptName', as: 'script_name' },
    { source: 'browserCloseReason', as: 'browser_close_reason' },
    { source: 'clientLibrary', as: 'client_library' },
    { source: 'recordingMode', as: 'recording_mode' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    avg_concurrent_sessions: { type: 'float', source: ['avg', 'avgConcurrentSessions'] },
    unique_connections: { type: 'int', source: ['uniq', 'connectionIdCount'] },
    unique_sessions: { type: 'int', source: ['uniq', 'sessionIdCount'] },
  },
};

export const BROWSER_ISOLATION_SESSIONS: DatasetQuery = {
  key: 'browser_isolation_sessions',
  measurement: 'cf_browser_isolation_sessions',
  field: 'browserIsolationSessionsAdaptiveGroups',
  dimensions: ['datetimeMinute'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [],
  fields: { sessions: { type: 'int', source: ['_top', 'count'] } },
};

export const BROWSER_ISOLATION_USER_ACTIONS: DatasetQuery = {
  key: 'browser_isolation_user_actions',
  measurement: 'cf_browser_isolation_user_actions',
  field: 'browserIsolationUserActionsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'type', 'decision'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'type', as: 'action_type' },
    { source: 'decision', as: 'decision' },
  ],
  fields: { actions: { type: 'int', source: ['_top', 'count'] } },
};

export const STREAM_MINUTES_VIEWED: DatasetQuery = {
  key: 'stream_minutes_viewed',
  measurement: 'cf_stream_minutes_viewed',
  field: 'streamMinutesViewedAdaptiveGroups',
  dimensions: ['datetimeMinute', 'clientCountryName', 'mediaType'],
  topLevelFields: ['count'],
  blocks: { sum: ['minutesViewed'] },
  tags: [
    { source: 'clientCountryName', as: 'client_country' },
    { source: 'mediaType', as: 'media_type' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    minutes_viewed: { type: 'float', source: ['sum', 'minutesViewed'] },
  },
};

export const STREAM_CMCD: DatasetQuery = {
  key: 'stream_cmcd',
  measurement: 'cf_stream_cmcd',
  field: 'streamCMCDAdaptiveGroups',
  dimensions: ['datetimeMinute', 'streamType', 'streamingFormat', 'country'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['millisecondsViewed'],
    avg: [
      'bufferLength',
      'bufferStarvationDuration',
      'encodedBitrate',
      'initialBufferStarvationDuration',
      'measuredThroughput',
    ],
    uniq: ['viewers'],
  },
  tags: [
    { source: 'streamType', as: 'stream_type' },
    { source: 'streamingFormat', as: 'streaming_format' },
    { source: 'country', as: 'country' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    milliseconds_viewed: { type: 'int', source: ['sum', 'millisecondsViewed'] },
    avg_buffer_length: { type: 'float', source: ['avg', 'bufferLength'] },
    avg_buffer_starvation_duration: { type: 'float', source: ['avg', 'bufferStarvationDuration'] },
    avg_encoded_bitrate: { type: 'float', source: ['avg', 'encodedBitrate'] },
    avg_initial_buffer_starvation_duration: { type: 'float', source: ['avg', 'initialBufferStarvationDuration'] },
    avg_measured_throughput: { type: 'float', source: ['avg', 'measuredThroughput'] },
    unique_viewers: { type: 'int', source: ['uniq', 'viewers'] },
  },
};

export const VIDEO_BUFFER_EVENTS: DatasetQuery = {
  key: 'video_buffer_events',
  measurement: 'cf_video_buffer_events',
  field: 'videoBufferEventsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'clientCountryName', 'deviceType'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'clientCountryName', as: 'client_country' },
    { source: 'deviceType', as: 'device_type' },
  ],
  fields: { events: { type: 'int', source: ['_top', 'count'] } },
};

export const VIDEO_PLAYBACK_EVENTS: DatasetQuery = {
  key: 'video_playback_events',
  measurement: 'cf_video_playback_events',
  field: 'videoPlaybackEventsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'clientCountryName', 'deviceType'],
  topLevelFields: ['count'],
  blocks: { sum: ['timeViewedMinutes'] },
  tags: [
    { source: 'clientCountryName', as: 'client_country' },
    { source: 'deviceType', as: 'device_type' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    time_viewed_minutes: { type: 'float', source: ['sum', 'timeViewedMinutes'] },
  },
};

export const VIDEO_QUALITY_EVENTS: DatasetQuery = {
  key: 'video_quality_events',
  measurement: 'cf_video_quality_events',
  field: 'videoQualityEventsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'clientCountryName', 'deviceType', 'qualityResolution'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'clientCountryName', as: 'client_country' },
    { source: 'deviceType', as: 'device_type' },
    { source: 'qualityResolution', as: 'quality_resolution' },
  ],
  fields: { events: { type: 'int', source: ['_top', 'count'] } },
};

export const LIVE_INPUT_EVENTS: DatasetQuery = {
  key: 'live_input_events',
  measurement: 'cf_live_input_events',
  field: 'liveInputEventsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'inputId', 'eventCode'],
  topLevelFields: ['count'],
  blocks: {
    avg: ['bitRateMinute', 'gopByteSize', 'gopDuration', 'gopUploadTime', 'uploadDurationRatio'],
    max: ['gopByteSize', 'gopDuration', 'gopUploadTime', 'uploadDurationRatio'],
  },
  tags: [
    { source: 'inputId', as: 'input_id' },
    { source: 'eventCode', as: 'event_code' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    avg_bit_rate: { type: 'float', source: ['avg', 'bitRateMinute'] },
    avg_gop_byte_size: { type: 'float', source: ['avg', 'gopByteSize'] },
    avg_gop_duration: { type: 'float', source: ['avg', 'gopDuration'] },
    avg_gop_upload_time: { type: 'float', source: ['avg', 'gopUploadTime'] },
    avg_upload_duration_ratio: { type: 'float', source: ['avg', 'uploadDurationRatio'] },
    max_gop_byte_size: { type: 'float', source: ['max', 'gopByteSize'] },
    max_gop_duration: { type: 'float', source: ['max', 'gopDuration'] },
    max_gop_upload_time: { type: 'float', source: ['max', 'gopUploadTime'] },
  },
};

export const REALTIME_KIT_USAGE: DatasetQuery = {
  key: 'realtime_kit_usage',
  measurement: 'cf_realtime_kit_usage',
  field: 'realtimeKitUsageAdaptiveGroups',
  dimensions: ['datetimeMinute', 'appId'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['audioMinutes', 'exportAudioMinutes', 'exportMinutes', 'mediaMinutes'],
  },
  tags: [{ source: 'appId', as: 'app_id' }],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    audio_minutes: { type: 'float', source: ['sum', 'audioMinutes'] },
    export_audio_minutes: { type: 'float', source: ['sum', 'exportAudioMinutes'] },
    export_minutes: { type: 'float', source: ['sum', 'exportMinutes'] },
    media_minutes: { type: 'float', source: ['sum', 'mediaMinutes'] },
  },
};

export const CALLS_USAGE: DatasetQuery = {
  key: 'calls_usage',
  measurement: 'cf_calls_usage',
  field: 'callsUsageAdaptiveGroups',
  dimensions: ['datetimeMinute', 'appId', 'trackType'],
  blocks: { sum: ['egressBytes', 'ingressBytes'] },
  tags: [
    { source: 'appId', as: 'app_id' },
    { source: 'trackType', as: 'track_type' },
  ],
  fields: {
    egress_bytes: { type: 'int', source: ['sum', 'egressBytes'] },
    ingress_bytes: { type: 'int', source: ['sum', 'ingressBytes'] },
  },
};

export const CALLS_TURN_USAGE: DatasetQuery = {
  key: 'calls_turn_usage',
  measurement: 'cf_calls_turn_usage',
  field: 'callsTurnUsageAdaptiveGroups',
  dimensions: ['datetimeMinute', 'datacenterCode', 'datacenterCountry'],
  blocks: {
    sum: ['egressBytes', 'ingressBytes'],
    avg: ['concurrentConnectionsMinute'],
  },
  tags: [
    { source: 'datacenterCode', as: 'datacenter_code' },
    { source: 'datacenterCountry', as: 'datacenter_country' },
  ],
  fields: {
    egress_bytes: { type: 'int', source: ['sum', 'egressBytes'] },
    ingress_bytes: { type: 'int', source: ['sum', 'ingressBytes'] },
    avg_concurrent_connections: { type: 'float', source: ['avg', 'concurrentConnectionsMinute'] },
  },
};

export const IMAGES_REQUESTS: DatasetQuery = {
  key: 'images_requests',
  measurement: 'cf_images_requests',
  field: 'imagesRequestsAdaptiveGroups',
  dimensions: ['datetimeMinute'],
  blocks: {
    sum: ['requests'],
    avg: ['sampleInterval'],
  },
  tags: [],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

export const TO_MARKDOWN: DatasetQuery = {
  key: 'to_markdown',
  measurement: 'cf_to_markdown',
  field: 'toMarkdownConversionAdaptiveGroups',
  dimensions: ['datetimeMinute', 'result', 'service', 'source', 'mimeType', 'errorReason'],
  topLevelFields: ['count'],
  blocks: {
    avg: ['completed', 'durationMs', 'fileSize'],
    max: ['durationMs', 'fileSize'],
    min: ['durationMs', 'fileSize'],
  },
  tags: [
    { source: 'result', as: 'result' },
    { source: 'service', as: 'service' },
    { source: 'source', as: 'source' },
    { source: 'mimeType', as: 'mime_type' },
    { source: 'errorReason', as: 'error_reason' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    avg_completed: { type: 'float', source: ['avg', 'completed'] },
    avg_duration_ms: { type: 'float', source: ['avg', 'durationMs'] },
    avg_file_size: { type: 'float', source: ['avg', 'fileSize'] },
    max_duration_ms: { type: 'float', source: ['max', 'durationMs'] },
    max_file_size: { type: 'float', source: ['max', 'fileSize'] },
    min_duration_ms: { type: 'float', source: ['min', 'durationMs'] },
    min_file_size: { type: 'float', source: ['min', 'fileSize'] },
  },
};

export const RUM_PAGELOAD: DatasetQuery = {
  key: 'rum_pageload',
  measurement: 'cf_rum_pageload',
  field: 'rumPageloadEventsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'siteTag', 'bot', 'countryName', 'deviceType'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['visits'],
    avg: ['sampleInterval'],
  },
  tags: [
    { source: 'siteTag', as: 'site_tag' },
    { source: 'bot', as: 'bot' },
    { source: 'countryName', as: 'country' },
    { source: 'deviceType', as: 'device_type' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    visits: { type: 'int', source: ['sum', 'visits'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

export const RUM_PERFORMANCE: DatasetQuery = {
  key: 'rum_performance',
  measurement: 'cf_rum_performance',
  field: 'rumPerformanceEventsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'siteTag', 'countryName', 'deviceType'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['visits'],
    avg: [
      'connectionTime',
      'dnsTime',
      'firstContentfulPaint',
      'firstPaint',
      'loadEventTime',
      'pageLoadTime',
      'pageRenderTime',
      'requestTime',
      'responseTime',
    ],
    quantiles: [
      'pageLoadTimeP50',
      'pageLoadTimeP95',
      'pageLoadTimeP99',
      'firstContentfulPaintP50',
      'firstContentfulPaintP95',
      'firstContentfulPaintP99',
    ],
  },
  tags: [
    { source: 'siteTag', as: 'site_tag' },
    { source: 'countryName', as: 'country' },
    { source: 'deviceType', as: 'device_type' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    visits: { type: 'int', source: ['sum', 'visits'] },
    avg_connection_time_ms: { type: 'float', source: ['avg', 'connectionTime'] },
    avg_dns_time_ms: { type: 'float', source: ['avg', 'dnsTime'] },
    avg_first_contentful_paint_ms: { type: 'float', source: ['avg', 'firstContentfulPaint'] },
    avg_first_paint_ms: { type: 'float', source: ['avg', 'firstPaint'] },
    avg_load_event_time_ms: { type: 'float', source: ['avg', 'loadEventTime'] },
    avg_page_load_time_ms: { type: 'float', source: ['avg', 'pageLoadTime'] },
    avg_page_render_time_ms: { type: 'float', source: ['avg', 'pageRenderTime'] },
    avg_request_time_ms: { type: 'float', source: ['avg', 'requestTime'] },
    avg_response_time_ms: { type: 'float', source: ['avg', 'responseTime'] },
    p50_page_load_time_ms: { type: 'float', source: ['quantiles', 'pageLoadTimeP50'] },
    p95_page_load_time_ms: { type: 'float', source: ['quantiles', 'pageLoadTimeP95'] },
    p99_page_load_time_ms: { type: 'float', source: ['quantiles', 'pageLoadTimeP99'] },
    p50_fcp_ms: { type: 'float', source: ['quantiles', 'firstContentfulPaintP50'] },
    p95_fcp_ms: { type: 'float', source: ['quantiles', 'firstContentfulPaintP95'] },
    p99_fcp_ms: { type: 'float', source: ['quantiles', 'firstContentfulPaintP99'] },
  },
};

export const RUM_WEB_VITALS: DatasetQuery = {
  key: 'rum_web_vitals',
  measurement: 'cf_rum_web_vitals',
  field: 'rumWebVitalsEventsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'siteTag', 'countryName', 'deviceType'],
  topLevelFields: ['count'],
  blocks: {
    sum: [
      'clsGood',
      'clsNeedsImprovement',
      'clsPoor',
      'clsTotal',
      'fcpGood',
      'fcpNeedsImprovement',
      'fcpPoor',
      'fcpTotal',
      'fidGood',
      'fidNeedsImprovement',
      'fidPoor',
      'fidTotal',
      'inpGood',
      'inpNeedsImprovement',
      'inpPoor',
      'inpTotal',
      'lcpGood',
      'lcpNeedsImprovement',
      'lcpPoor',
      'lcpTotal',
      'ttfbGood',
      'ttfbNeedsImprovement',
      'ttfbPoor',
      'ttfbTotal',
      'visits',
    ],
    avg: [
      'cumulativeLayoutShift',
      'firstContentfulPaint',
      'firstInputDelay',
      'interactionToNextPaint',
      'largestContentfulPaint',
      'timeToFirstByte',
    ],
    quantiles: [
      'largestContentfulPaintP75',
      'largestContentfulPaintP95',
      'cumulativeLayoutShiftP75',
      'cumulativeLayoutShiftP95',
      'interactionToNextPaintP75',
      'interactionToNextPaintP95',
    ],
  },
  tags: [
    { source: 'siteTag', as: 'site_tag' },
    { source: 'countryName', as: 'country' },
    { source: 'deviceType', as: 'device_type' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    visits: { type: 'int', source: ['sum', 'visits'] },
    cls_good: { type: 'int', source: ['sum', 'clsGood'] },
    cls_needs_improvement: { type: 'int', source: ['sum', 'clsNeedsImprovement'] },
    cls_poor: { type: 'int', source: ['sum', 'clsPoor'] },
    cls_total: { type: 'int', source: ['sum', 'clsTotal'] },
    fcp_good: { type: 'int', source: ['sum', 'fcpGood'] },
    fcp_needs_improvement: { type: 'int', source: ['sum', 'fcpNeedsImprovement'] },
    fcp_poor: { type: 'int', source: ['sum', 'fcpPoor'] },
    fcp_total: { type: 'int', source: ['sum', 'fcpTotal'] },
    fid_good: { type: 'int', source: ['sum', 'fidGood'] },
    fid_needs_improvement: { type: 'int', source: ['sum', 'fidNeedsImprovement'] },
    fid_poor: { type: 'int', source: ['sum', 'fidPoor'] },
    fid_total: { type: 'int', source: ['sum', 'fidTotal'] },
    inp_good: { type: 'int', source: ['sum', 'inpGood'] },
    inp_needs_improvement: { type: 'int', source: ['sum', 'inpNeedsImprovement'] },
    inp_poor: { type: 'int', source: ['sum', 'inpPoor'] },
    inp_total: { type: 'int', source: ['sum', 'inpTotal'] },
    lcp_good: { type: 'int', source: ['sum', 'lcpGood'] },
    lcp_needs_improvement: { type: 'int', source: ['sum', 'lcpNeedsImprovement'] },
    lcp_poor: { type: 'int', source: ['sum', 'lcpPoor'] },
    lcp_total: { type: 'int', source: ['sum', 'lcpTotal'] },
    ttfb_good: { type: 'int', source: ['sum', 'ttfbGood'] },
    ttfb_needs_improvement: { type: 'int', source: ['sum', 'ttfbNeedsImprovement'] },
    ttfb_poor: { type: 'int', source: ['sum', 'ttfbPoor'] },
    ttfb_total: { type: 'int', source: ['sum', 'ttfbTotal'] },
    avg_cls: { type: 'float', source: ['avg', 'cumulativeLayoutShift'] },
    avg_fcp_ms: { type: 'float', source: ['avg', 'firstContentfulPaint'] },
    avg_fid_ms: { type: 'float', source: ['avg', 'firstInputDelay'] },
    avg_inp_ms: { type: 'float', source: ['avg', 'interactionToNextPaint'] },
    avg_lcp_ms: { type: 'float', source: ['avg', 'largestContentfulPaint'] },
    avg_ttfb_ms: { type: 'float', source: ['avg', 'timeToFirstByte'] },
    p75_lcp_ms: { type: 'float', source: ['quantiles', 'largestContentfulPaintP75'] },
    p95_lcp_ms: { type: 'float', source: ['quantiles', 'largestContentfulPaintP95'] },
    p75_cls: { type: 'float', source: ['quantiles', 'cumulativeLayoutShiftP75'] },
    p95_cls: { type: 'float', source: ['quantiles', 'cumulativeLayoutShiftP95'] },
    p75_inp_ms: { type: 'float', source: ['quantiles', 'interactionToNextPaintP75'] },
    p95_inp_ms: { type: 'float', source: ['quantiles', 'interactionToNextPaintP95'] },
  },
};

export const PIPELINES_INGESTION: DatasetQuery = {
  key: 'pipelines_ingestion',
  measurement: 'cf_pipelines_ingestion',
  field: 'pipelinesIngestionAdaptiveGroups',
  dimensions: ['datetimeMinute', 'pipelineId'],
  topLevelFields: ['count'],
  blocks: { sum: ['ingestedBytes', 'ingestedRecords'] },
  tags: [{ source: 'pipelineId', as: 'pipeline_id' }],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    ingested_bytes: { type: 'int', source: ['sum', 'ingestedBytes'] },
    ingested_records: { type: 'int', source: ['sum', 'ingestedRecords'] },
  },
};

export const PIPELINES_DELIVERY: DatasetQuery = {
  key: 'pipelines_delivery',
  measurement: 'cf_pipelines_delivery',
  field: 'pipelinesDeliveryAdaptiveGroups',
  dimensions: ['datetimeMinute', 'pipelineId'],
  topLevelFields: ['count'],
  blocks: { sum: ['deliveredBytes'] },
  tags: [{ source: 'pipelineId', as: 'pipeline_id' }],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    delivered_bytes: { type: 'int', source: ['sum', 'deliveredBytes'] },
  },
};

export const PIPELINES_OPERATOR: DatasetQuery = {
  key: 'pipelines_operator',
  measurement: 'cf_pipelines_operator',
  field: 'pipelinesOperatorAdaptiveGroups',
  dimensions: ['datetimeMinute', 'pipelineId', 'streamId'],
  blocks: { sum: ['bytesIn', 'decodeErrors', 'recordsIn'] },
  tags: [
    { source: 'pipelineId', as: 'pipeline_id' },
    { source: 'streamId', as: 'stream_id' },
  ],
  fields: {
    bytes_in: { type: 'int', source: ['sum', 'bytesIn'] },
    decode_errors: { type: 'int', source: ['sum', 'decodeErrors'] },
    records_in: { type: 'int', source: ['sum', 'recordsIn'] },
  },
};

export const PIPELINES_SINK: DatasetQuery = {
  key: 'pipelines_sink',
  measurement: 'cf_pipelines_sink',
  field: 'pipelinesSinkAdaptiveGroups',
  dimensions: ['datetimeMinute', 'pipelineId', 'sinkId'],
  blocks: {
    sum: ['bytesWritten', 'filesWritten', 'recordsWritten', 'rowGroupsWritten', 'uncompressedBytesWritten'],
  },
  tags: [
    { source: 'pipelineId', as: 'pipeline_id' },
    { source: 'sinkId', as: 'sink_id' },
  ],
  fields: {
    bytes_written: { type: 'int', source: ['sum', 'bytesWritten'] },
    files_written: { type: 'int', source: ['sum', 'filesWritten'] },
    records_written: { type: 'int', source: ['sum', 'recordsWritten'] },
    row_groups_written: { type: 'int', source: ['sum', 'rowGroupsWritten'] },
    uncompressed_bytes_written: { type: 'int', source: ['sum', 'uncompressedBytesWritten'] },
  },
};

export const CONTAINERS: DatasetQuery = {
  key: 'containers',
  measurement: 'cf_containers',
  field: 'containersMetricsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'applicationId', 'region', 'procType'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['allocatedCpu', 'allocatedDisk', 'allocatedMemory', 'containerUptime', 'cpuTimeSec', 'rxBytes', 'txBytes'],
    avg: ['cpuLoad', 'cpuUtilization', 'memory'],
    max: ['cpuLoad', 'cpuUtilization', 'diskUsage', 'diskUsagePercentage', 'memory'],
  },
  tags: [
    { source: 'applicationId', as: 'application_id' },
    { source: 'region', as: 'region' },
    { source: 'procType', as: 'proc_type' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    allocated_cpu: { type: 'int', source: ['sum', 'allocatedCpu'] },
    allocated_disk: { type: 'int', source: ['sum', 'allocatedDisk'] },
    allocated_memory: { type: 'int', source: ['sum', 'allocatedMemory'] },
    container_uptime_sum: { type: 'int', source: ['sum', 'containerUptime'] },
    cpu_time_sec: { type: 'float', source: ['sum', 'cpuTimeSec'] },
    rx_bytes: { type: 'int', source: ['sum', 'rxBytes'] },
    tx_bytes: { type: 'int', source: ['sum', 'txBytes'] },
    avg_cpu_load: { type: 'float', source: ['avg', 'cpuLoad'] },
    avg_cpu_utilization: { type: 'float', source: ['avg', 'cpuUtilization'] },
    avg_memory: { type: 'float', source: ['avg', 'memory'] },
    max_cpu_load: { type: 'float', source: ['max', 'cpuLoad'] },
    max_cpu_utilization: { type: 'float', source: ['max', 'cpuUtilization'] },
    max_disk_usage: { type: 'float', source: ['max', 'diskUsage'] },
    max_disk_usage_percentage: { type: 'float', source: ['max', 'diskUsagePercentage'] },
    max_memory: { type: 'float', source: ['max', 'memory'] },
  },
};

export const TURNSTILE: DatasetQuery = {
  key: 'turnstile',
  measurement: 'cf_turnstile',
  field: 'turnstileAdaptiveGroups',
  dimensions: ['datetimeMinute', 'action', 'eventType', 'siteKey', 'countryCode'],
  topLevelFields: ['count'],
  blocks: { avg: ['sampleInterval'] },
  tags: [
    { source: 'action', as: 'action' },
    { source: 'eventType', as: 'event_type' },
    { source: 'siteKey', as: 'site_key' },
    { source: 'countryCode', as: 'country_code' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

export const SIPPY_OPERATIONS: DatasetQuery = {
  key: 'sippy_operations',
  measurement: 'cf_sippy_operations',
  field: 'sippyOperationsAdaptiveGroups',
  dimensions: ['datetimeMinute', 'action', 'status', 'bucket', 'target'],
  topLevelFields: ['count'],
  blocks: { sum: ['size'] },
  tags: [
    { source: 'action', as: 'action' },
    { source: 'status', as: 'status' },
    { source: 'bucket', as: 'bucket' },
    { source: 'target', as: 'target' },
  ],
  fields: {
    operations: { type: 'int', source: ['_top', 'count'] },
    size_bytes: { type: 'int', source: ['sum', 'size'] },
  },
};

// =============================================================================
// Additional zone-scope datasets. These are iterated per-zone by the collector
// (one subrequest per zone per tick each), so conservative dimensions are
// especially important here.
// =============================================================================

export const API_GATEWAY_SESSIONS: DatasetQuery = {
  key: 'api_gateway_sessions',
  measurement: 'cf_api_gateway_sessions',
  field: 'apiGatewayMatchedSessionIDsAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'apiGatewayMatchedSessionIdentifierType'],
  topLevelFields: ['count'],
  blocks: { avg: ['sampleInterval'] },
  tags: [{ source: 'apiGatewayMatchedSessionIdentifierType', as: 'identifier_type' }],
  fields: {
    matched_sessions: { type: 'int', source: ['_top', 'count'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

export const CACHE_RESERVE_OPERATIONS: DatasetQuery = {
  key: 'cache_reserve_operations',
  measurement: 'cf_cache_reserve_operations',
  field: 'cacheReserveOperationsAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'actionStatus', 'operationClass'],
  blocks: { sum: ['requests'] },
  tags: [
    { source: 'actionStatus', as: 'action_status' },
    { source: 'operationClass', as: 'operation_class' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
  },
};

export const CACHE_RESERVE_STORAGE: DatasetQuery = {
  key: 'cache_reserve_storage',
  measurement: 'cf_cache_reserve_storage',
  field: 'cacheReserveStorageAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'bucketName'],
  blocks: { max: ['objectCount', 'storedBytes'] },
  tags: [{ source: 'bucketName', as: 'bucket_name' }],
  fields: {
    object_count: { type: 'int', source: ['max', 'objectCount'] },
    stored_bytes: { type: 'int', source: ['max', 'storedBytes'] },
  },
};

export const DMARC_REPORTS: DatasetQuery = {
  key: 'dmarc_reports',
  measurement: 'cf_dmarc_reports',
  field: 'dmarcReportsSourcesAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'disposition', 'dkim', 'spf'],
  blocks: {
    sum: ['dkimPass', 'dmarc', 'spfPass', 'totalMatchingMessages'],
    uniq: ['ipCount'],
  },
  tags: [
    { source: 'disposition', as: 'disposition' },
    { source: 'dkim', as: 'dkim' },
    { source: 'spf', as: 'spf' },
  ],
  fields: {
    messages: { type: 'int', source: ['sum', 'totalMatchingMessages'] },
    dmarc_pass: { type: 'int', source: ['sum', 'dmarc'] },
    dkim_pass: { type: 'int', source: ['sum', 'dkimPass'] },
    spf_pass: { type: 'int', source: ['sum', 'spfPass'] },
    unique_ips: { type: 'int', source: ['uniq', 'ipCount'] },
  },
};

export const DNS_ANALYTICS: DatasetQuery = {
  key: 'dns_analytics',
  measurement: 'cf_dns_analytics',
  field: 'dnsAnalyticsAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'queryType', 'responseCode', 'responseCached'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['countNotCachedAndNotStale', 'countStale'],
    avg: ['processingTimeUs', 'sampleInterval'],
  },
  tags: [
    { source: 'queryType', as: 'query_type' },
    { source: 'responseCode', as: 'response_code' },
    { source: 'responseCached', as: 'response_cached' },
  ],
  fields: {
    queries: { type: 'int', source: ['_top', 'count'] },
    queries_uncached: { type: 'int', source: ['sum', 'countNotCachedAndNotStale'] },
    queries_stale: { type: 'int', source: ['sum', 'countStale'] },
    processing_time_us_avg: { type: 'float', source: ['avg', 'processingTimeUs'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

export const EMAIL_ROUTING: DatasetQuery = {
  key: 'email_routing',
  measurement: 'cf_email_routing',
  field: 'emailRoutingAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'action', 'status', 'dkim', 'dmarc', 'spf'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'action', as: 'action' },
    { source: 'status', as: 'status' },
    { source: 'dkim', as: 'dkim' },
    { source: 'dmarc', as: 'dmarc' },
    { source: 'spf', as: 'spf' },
  ],
  fields: {
    messages: { type: 'int', source: ['_top', 'count'] },
  },
};

export const EMAIL_SENDING: DatasetQuery = {
  key: 'email_sending',
  measurement: 'cf_email_sending',
  field: 'emailSendingAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'eventType', 'status', 'dkim', 'dmarc', 'spf'],
  topLevelFields: ['count'],
  blocks: {},
  tags: [
    { source: 'eventType', as: 'event_type' },
    { source: 'status', as: 'status' },
    { source: 'dkim', as: 'dkim' },
    { source: 'dmarc', as: 'dmarc' },
    { source: 'spf', as: 'spf' },
  ],
  fields: {
    messages: { type: 'int', source: ['_top', 'count'] },
  },
};

export const LOGPUSH_HEALTH: DatasetQuery = {
  key: 'logpush_health',
  measurement: 'cf_logpush_health',
  field: 'logpushHealthAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'destinationType', 'status', 'final', 'success', 'jobId'],
  topLevelFields: ['count'],
  blocks: {
    sum: ['bytes', 'bytesCompressed', 'records', 'uploads'],
    avg: ['uploadDuration', 'sampleInterval'],
  },
  tags: [
    { source: 'destinationType', as: 'destination_type' },
    { source: 'status', as: 'status' },
    { source: 'final', as: 'final' },
    { source: 'success', as: 'success' },
    { source: 'jobId', as: 'job_id' },
  ],
  fields: {
    events: { type: 'int', source: ['_top', 'count'] },
    bytes: { type: 'int', source: ['sum', 'bytes'] },
    bytes_compressed: { type: 'int', source: ['sum', 'bytesCompressed'] },
    records: { type: 'int', source: ['sum', 'records'] },
    uploads: { type: 'int', source: ['sum', 'uploads'] },
    upload_duration_avg: { type: 'float', source: ['avg', 'uploadDuration'] },
    sample_interval: { type: 'float', source: ['avg', 'sampleInterval'] },
  },
};

export const WORKERS_ZONE_INVOCATIONS: DatasetQuery = {
  key: 'workers_zone_invocations',
  measurement: 'cf_workers_zone_invocations',
  field: 'workersZoneInvocationsAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'constantScriptId', 'httpResponseStatus', 'status'],
  blocks: {
    sum: ['requests', 'responseBodySize', 'subrequests', 'totalCpuTime'],
    avg: ['avgCpuTime'],
  },
  tags: [
    { source: 'constantScriptId', as: 'script_id' },
    { source: 'httpResponseStatus', as: 'http_status' },
    { source: 'status', as: 'status' },
  ],
  fields: {
    requests: { type: 'int', source: ['sum', 'requests'] },
    response_body_size: { type: 'int', source: ['sum', 'responseBodySize'] },
    subrequests: { type: 'int', source: ['sum', 'subrequests'] },
    total_cpu_time_us: { type: 'float', source: ['sum', 'totalCpuTime'] },
    avg_cpu_time_us: { type: 'float', source: ['avg', 'avgCpuTime'] },
  },
};

export const WORKERS_ZONE_SUBREQUESTS: DatasetQuery = {
  key: 'workers_zone_subrequests',
  measurement: 'cf_workers_zone_subrequests',
  field: 'workersZoneSubrequestsAdaptiveGroups',
  scope: 'zone',
  dimensions: ['datetimeMinute', 'cacheStatus', 'httpResponseStatus'],
  blocks: {
    sum: ['requestBodySize', 'requestBodySizeUncached', 'responseBodySize', 'subrequests'],
  },
  tags: [
    { source: 'cacheStatus', as: 'cache_status' },
    { source: 'httpResponseStatus', as: 'http_status' },
  ],
  fields: {
    subrequests: { type: 'int', source: ['sum', 'subrequests'] },
    request_body_size: { type: 'int', source: ['sum', 'requestBodySize'] },
    request_body_size_uncached: { type: 'int', source: ['sum', 'requestBodySizeUncached'] },
    response_body_size: { type: 'int', source: ['sum', 'responseBodySize'] },
  },
};

// Note: `cdnNetworkAnalyticsAdaptiveGroups` (network-layer CDN analytics) is
// plan-gated on Enterprise and returns `authz` on our plan. Zaraz (`zarazTrack*`,
// `zarazTriggers*`) uses a different filter input shape (`datetimeMinute_geq`
// instead of `datetime_geq`) that doesn't compose with our batched query
// pattern — skipped pending either adoption of Zaraz or the product being EOL'd.
// `cloudchamberMetricsAdaptiveGroups` is a duplicate schema of `containersMetrics`
// — we wire up containers only.
//
// Zone-scope datasets skipped as plan-gated on our account (return `does not
// have access to the path`): `cacheReserveRequestsAdaptiveGroups`,
// `healthCheckEventsAdaptiveGroups`, `loadBalancingRequestsAdaptiveGroups`,
// `nelReportsAdaptiveGroups`, `pageShieldReportsAdaptiveGroups`,
// `waitingRoomAnalyticsAdaptiveGroups`, `firewallEventsAdaptiveGroups`.

export const ALL_DATASETS: DatasetQuery[] = [
  WORKERS_INVOCATIONS,
  WORKERS_SUBREQUESTS,
  WORKERS_OVERVIEW,
  WORKERS_ANALYTICS_ENGINE,
  WORKERS_BUILDS,
  WORKERS_VPC,
  WORKER_PLACEMENT,
  WORKFLOWS,
  D1_QUERIES,
  D1_QUERIES_DETAIL,
  D1_STORAGE,
  R2_OPERATIONS,
  R2_STORAGE,
  SIPPY_OPERATIONS,
  KV_OPERATIONS,
  KV_STORAGE,
  DURABLE_OBJECTS_INVOCATIONS,
  DURABLE_OBJECTS_PERIODIC,
  DURABLE_OBJECTS_STORAGE,
  DURABLE_OBJECTS_SQL_STORAGE,
  DURABLE_OBJECTS_SUBREQUESTS,
  QUEUE_OPERATIONS,
  QUEUE_BACKLOG,
  QUEUE_CONSUMER,
  HYPERDRIVE_QUERIES,
  HYPERDRIVE_POOL,
  HTTP_REQUESTS_OVERVIEW,
  HTTP_REQUESTS_DETAIL,
  API_GATEWAY_SESSIONS,
  CACHE_RESERVE_OPERATIONS,
  CACHE_RESERVE_STORAGE,
  DMARC_REPORTS,
  DNS_ANALYTICS,
  EMAIL_ROUTING,
  EMAIL_SENDING,
  LOGPUSH_HEALTH,
  WORKERS_ZONE_INVOCATIONS,
  WORKERS_ZONE_SUBREQUESTS,
  PAGES_FUNCTIONS_INVOCATIONS,
  AI_GATEWAY_REQUESTS,
  AI_GATEWAY_CACHE,
  AI_GATEWAY_ERRORS,
  AI_GATEWAY_SIZE,
  AI_INFERENCE,
  AI_SEARCH_API,
  AI_SEARCH_INGESTED_ITEMS,
  AUTO_RAG_CONFIG_API,
  AUTO_RAG_ENGINE,
  VECTORIZE_OPERATIONS,
  VECTORIZE_QUERIES,
  VECTORIZE_STORAGE,
  VECTORIZE_WRITES,
  BROWSER_RENDERING_API,
  BROWSER_RENDERING_BINDING_SESSIONS,
  BROWSER_RENDERING_BROWSER_TIME,
  BROWSER_RENDERING_EVENTS,
  BROWSER_ISOLATION_SESSIONS,
  BROWSER_ISOLATION_USER_ACTIONS,
  STREAM_MINUTES_VIEWED,
  STREAM_CMCD,
  VIDEO_BUFFER_EVENTS,
  VIDEO_PLAYBACK_EVENTS,
  VIDEO_QUALITY_EVENTS,
  LIVE_INPUT_EVENTS,
  REALTIME_KIT_USAGE,
  CALLS_USAGE,
  CALLS_TURN_USAGE,
  IMAGES_REQUESTS,
  TO_MARKDOWN,
  RUM_PAGELOAD,
  RUM_PERFORMANCE,
  RUM_WEB_VITALS,
  PIPELINES_INGESTION,
  PIPELINES_DELIVERY,
  PIPELINES_OPERATOR,
  PIPELINES_SINK,
  CONTAINERS,
  TURNSTILE,
];
