import { has } from 'lodash';
import { i18n } from '@kbn/i18n';

// need to get rid of angular from these
// @ts-ignore
import { TimeRange } from 'src/plugins/data/public';
import { SearchSource } from 'ui/courier/search_source';
// @ts-ignore

import { buildTabularInspectorData } from 'ui/inspector/build_tabular_inspector_data';
import {
  getRequestInspectorStats,
  getResponseInspectorStats,
} from 'ui/courier/utils/courier_inspector_utils';
import { calculateObjectHash } from 'ui/vis/lib/calculate_object_hash';
import { getTime } from 'ui/timefilter';
import { RequestHandlerParams } from 'ui/visualize/loader/embedded_visualize_handler';
// @ts-ignore
import { tabifyAggResponse } from 'ui/agg_response/tabify/tabify';
import { start as data } from 'data/legacy';

export const handleCourierRequest = async ({
  searchSource,
  aggs,
  timeRange,
  query,
  filters,
  forceFetch,
  partialRows,
  metricsAtAllLevels,
  inspectorAdapters,
  queryFilter,
  abortSignal,
}: RequestHandlerParams) => {
  // Create a new search source that inherits the original search source
  // but has the appropriate timeRange applied via a filter.
  // This is a temporary solution until we properly pass down all required
  // information for the request to the request handler (https://github.com/elastic/kibana/issues/16641).
  // Using callParentStartHandlers: true we make sure, that the parent searchSource
  // onSearchRequestStart will be called properly even though we use an inherited
  // search source.
  const timeFilterSearchSource = searchSource.createChild({ callParentStartHandlers: true });
  const requestSearchSource = timeFilterSearchSource.createChild({ callParentStartHandlers: true });

  aggs.setTimeRange(timeRange as TimeRange);

  // For now we need to mirror the history of the passed search source, since
  // the request inspector wouldn't work otherwise.
  Object.defineProperty(requestSearchSource, 'history', {
    get() {
      return searchSource.history;
    },
    set(history) {
      return (searchSource.history = history);
    },
  });

  requestSearchSource.setField('aggs', function() {
    return aggs.toDsl(metricsAtAllLevels);
  });

  requestSearchSource.onRequestStart((paramSearchSource: SearchSource, searchRequest: unknown) => {
    return aggs.onSearchRequestStart(paramSearchSource, searchRequest);
  });

  if (timeRange) {
    timeFilterSearchSource.setField('filter', () => {
      return getTime(searchSource.getField('index'), timeRange);
    });
  }

  requestSearchSource.setField('filter', filters);
  requestSearchSource.setField('query', query);

  const reqBody = await requestSearchSource.getSearchRequestBody();

  const queryHash = calculateObjectHash(reqBody);
  // We only need to reexecute the query, if forceFetch was true or the hash of the request body has changed
  // since the last request
  const shouldQuery = forceFetch || searchSource.lastQuery !== queryHash;

  if (shouldQuery) {
    inspectorAdapters.requests.reset();
    const request = inspectorAdapters.requests.start(
      i18n.translate('interpreter.functions.esaggs.inspector.dataRequest.title', {
        defaultMessage: 'Data',
      }),
      {
        description: i18n.translate(
          'interpreter.functions.esaggs.inspector.dataRequest.description',
          {
            defaultMessage:
              'This request queries Elasticsearch to fetch the data for the visualization.',
          }
        ),
      }
    );
    request.stats(getRequestInspectorStats(requestSearchSource));

    try {
      // Abort any in-progress requests before fetching again
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => requestSearchSource.cancelQueued());
      }

      const response = await requestSearchSource.fetch();

      searchSource.lastQuery = queryHash;

      request.stats(getResponseInspectorStats(searchSource, response)).ok({ json: response });

      searchSource.rawResponse = response;
    } catch (e) {
      // Log any error during request to the inspector
      request.error({ json: e });
      throw e;
    } finally {
      // Add the request body no matter if things went fine or not
      requestSearchSource.getSearchRequestBody().then((req: unknown) => {
        request.json(req);
      });
    }
  }

  // Note that rawResponse is not deeply cloned here, so downstream applications using courier
  // must take care not to mutate it, or it could have unintended side effects, e.g. displaying
  // response data incorrectly in the inspector.
  let resp = searchSource.rawResponse;
  for (const agg of aggs.aggs) {
    if (has(agg, 'type.postFlightRequest')) {
      resp = await agg.type.postFlightRequest(
        resp,
        aggs,
        agg,
        requestSearchSource,
        inspectorAdapters,
        abortSignal
      );
    }
  }

  searchSource.finalResponse = resp;

  const parsedTimeRange = timeRange ? getTime(aggs.indexPattern, timeRange) : null;
  const tabifyParams = {
    metricsAtAllLevels,
    partialRows,
    timeRange: parsedTimeRange ? parsedTimeRange.range : undefined,
  };

  const tabifyCacheHash = calculateObjectHash({ tabifyAggs: aggs, ...tabifyParams });
  // We only need to reexecute tabify, if either we did a new request or some input params to tabify changed
  const shouldCalculateNewTabify = shouldQuery || searchSource.lastTabifyHash !== tabifyCacheHash;

  if (shouldCalculateNewTabify) {
    searchSource.lastTabifyHash = tabifyCacheHash;
    searchSource.tabifiedResponse = tabifyAggResponse(
      aggs,
      searchSource.finalResponse,
      tabifyParams
    );
  }

  inspectorAdapters.data.setTabularLoader(
    () => buildTabularInspectorData(searchSource.tabifiedResponse, queryFilter),
    { returnsFormattedValues: true }
  );

  return searchSource.tabifiedResponse;
};
