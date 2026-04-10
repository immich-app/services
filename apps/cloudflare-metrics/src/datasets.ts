import type { DatasetQuery } from './types.js';

/**
 * Five-minute bucket granularity is used wherever possible because the
 * exporter runs on a 5-minute cron. Datasets that do not support a
 * `datetimeFiveMinutes` dimension fall back to `datetime` (raw bucket) or
 * `date` (daily rollup, e.g. Durable Objects storage).
 *
 * Dimension → tag mapping and field names use snake_case to match the
 * existing VictoriaMetrics conventions in other workers.
 */

export const WORKERS_INVOCATIONS: DatasetQuery = {
  key: 'workers_invocations',
  measurement: 'cf_workers_invocations',
  field: 'workersInvocationsAdaptive',
  dimensions: ['datetimeFiveMinutes', 'scriptName', 'status', 'scriptVersion', 'usageModel'],
  timestampDimension: 'datetimeFiveMinutes',
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
  dimensions: ['datetimeFiveMinutes', 'scriptName', 'hostname', 'cacheStatus', 'httpResponseStatus', 'requestOutcome'],
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
  dimensions: ['datetimeFiveMinutes', 'status', 'usageModel'],
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
  dimensions: ['datetimeFiveMinutes', 'databaseId', 'databaseRole'],
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
  dimensions: ['datetimeFiveMinutes', 'databaseId'],
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
  dimensions: ['datetimeFiveMinutes', 'bucketName', 'actionType', 'actionStatus', 'responseStatusCode', 'storageClass'],
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
  dimensions: ['datetimeFiveMinutes', 'bucketName', 'storageClass'],
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
  dimensions: ['datetimeFiveMinutes', 'namespaceId', 'actionType', 'result', 'responseStatusCode'],
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
  dimensions: ['datetimeFiveMinutes', 'namespaceId'],
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
  dimensions: ['datetimeFiveMinutes', 'namespaceId', 'scriptName', 'status', 'type'],
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
  dimensions: ['datetimeFiveMinutes', 'namespaceId'],
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
  dimensions: ['datetimeFiveMinutes'],
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
  dimensions: ['datetimeFiveMinutes', 'namespaceId'],
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
  dimensions: ['datetimeFiveMinutes', 'namespaceId', 'scriptName'],
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
  dimensions: ['datetimeFiveMinutes', 'queueId', 'actionType', 'consumerType', 'outcome'],
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
  dimensions: ['datetimeFiveMinutes', 'queueId'],
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
  dimensions: ['datetimeFiveMinutes', 'configId', 'cacheStatus', 'eventStatus', 'isFree'],
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
  timestampDimension: 'datetimeMinute',
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
  dimensions: [
    'datetimeFiveMinutes',
    'zoneTag',
    'clientCountryName',
    'clientRequestHTTPProtocol',
    'edgeResponseStatus',
  ],
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
  dimensions: ['datetimeFiveMinutes', 'scriptName', 'status', 'usageModel'],
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

export const ALL_DATASETS: DatasetQuery[] = [
  WORKERS_INVOCATIONS,
  WORKERS_SUBREQUESTS,
  WORKERS_OVERVIEW,
  D1_QUERIES,
  D1_STORAGE,
  R2_OPERATIONS,
  R2_STORAGE,
  KV_OPERATIONS,
  KV_STORAGE,
  DURABLE_OBJECTS_INVOCATIONS,
  DURABLE_OBJECTS_PERIODIC,
  DURABLE_OBJECTS_STORAGE,
  DURABLE_OBJECTS_SQL_STORAGE,
  DURABLE_OBJECTS_SUBREQUESTS,
  QUEUE_OPERATIONS,
  QUEUE_BACKLOG,
  HYPERDRIVE_QUERIES,
  HYPERDRIVE_POOL,
  HTTP_REQUESTS_OVERVIEW,
  PAGES_FUNCTIONS_INVOCATIONS,
];
