var scClient = require('socketcluster-client');
var ClusterBrokerClient = require('./cluster-broker-client').ClusterBrokerClient;
var uuid = require('node-uuid');

var DEFAULT_PORT = 7777;
var DEFAULT_MESSAGE_CACHE_DURATION = 10000;

// The options object needs to have a stateServerHost property.
module.exports.attach = function (broker, options) {
  var clusterClient = new ClusterBrokerClient();
  var lastestSnapshotTime = -1;
  var serverInstances = [];
  var processedMessagesLookup = {};
  var messageCacheDuration = options.messageCacheDuration || DEFAULT_MESSAGE_CACHE_DURATION;

  var updateServerCluster = function (updatePacket) {
    if (updatePacket.time > lastestSnapshotTime) {
      serverInstances = updatePacket.serverInstances;
      lastestSnapshotTime = updatePacket.time;
      return true;
    }
    return false;
  };

  var scStateSocketOptions = {
    hostname: options.stateServerHost, // Required option
    port: options.stateServerPort || DEFAULT_PORT
  };
  var stateSocket = scClient.connect(scStateSocketOptions);
  var stateSocketData = {
    instanceId: broker.instanceId
  };


  var getMapper = function (serverInstances) {
    return function (channelName) {
      var ch;
      var hash = channelName;

      for (var i = 0; i < channelName.length; i++) {
        ch = channelName.charCodeAt(i);
        hash = ((hash << 5) - hash) + ch;
        hash = hash & hash;
      }
      var targetIndex = Math.abs(hash) % serverInstances.length;
      return serverInstances[targetIndex];
    };
  };

  var sendClientState = function (stateName) {
    stateSocket.emit('clientSetState', {
      instanceState: stateName + ':' + JSON.stringify(serverInstances)
    });
  };

  var addNewSubMapping = function (data, respond) {
    var updated = updateServerCluster(data);
    if (updated) {
      var mapper = getMapper(serverInstances);
      clusterClient.subMapperPush(mapper, serverInstances);
      sendClientState('updatedSubs');
    }
    respond();
  };

  var completeMappingUpdates = function () {
    // This means that all clients have converged on the 'ready' state
    // When this happens, we can remove all mappings except for the latest one.
    while (clusterClient.pubMappers.length > 1) {
      clusterClient.pubMapperShift();
    }
    while (clusterClient.subMappers.length > 1) {
      clusterClient.subMapperShift();
    }
    sendClientState('active');
  };

  stateSocket.on('serverJoinCluster', addNewSubMapping);
  stateSocket.on('serverLeaveCluster', addNewSubMapping);

  stateSocket.on('clientStatesConverge', function (data, respond) {
    if (data.state == 'updatedSubs:' + JSON.stringify(serverInstances)) {
      var mapper = getMapper(serverInstances);
      clusterClient.pubMapperPush(mapper, serverInstances);
      clusterClient.pubMapperShift(mapper);
      sendClientState('updatedPubs');
    } else if (data.state == 'updatedPubs:' + JSON.stringify(serverInstances)) {
      completeMappingUpdates();
    }
    respond();
  });

  stateSocket.emit('clientJoinCluster', stateSocketData, function (err, data) {
    updateServerCluster(data);
    var mapper = getMapper(serverInstances);
    clusterClient.subMapperPush(mapper, serverInstances);
    clusterClient.pubMapperPush(mapper, serverInstances);
    sendClientState('active');
  });

  var removeMessageFromCache = function (messageId) {
    delete processedMessagesLookup[messageId];
  };

  var clusterMessageHandler = function (channelName, packet) {
    if (packet.sender == null || packet.sender != broker.instanceId) {
      if (processedMessagesLookup[packet.id] == null) {
        broker.publish(channelName, packet.data);
      } else {
        clearTimeout(processedMessagesLookup[packet.id]);
      }
      processedMessagesLookup[packet.id] = setTimeout(removeMessageFromCache.bind(null, packet.id), messageCacheDuration);
    }
  };
  clusterClient.on('message', clusterMessageHandler);

  broker.on('subscribe', function (channelName) {
    clusterClient.subscribe(channelName);
  });
  broker.on('unsubscribe', function (channelName) {
    clusterClient.unsubscribe(channelName);
  });
  broker.on('publish', function (channelName, data) {
    var packet = {
      sender: broker.instanceId || null,
      data: data,
      id: uuid.v4()
    };
    clusterClient.publish(channelName, packet);
  });
};