'use strict';

var pushly 			= require('pushly')(),
    _               = require('underscore'),
    api 			= {},
    async           = require('async'),
    moment          = require('moment'),
    common 			= require('./../../utils/common.js'),
    events          = require('./../data/events.js'),
    usage           = require('./../data/usage.js'),
    cluster			= require('cluster'),
    mess            = require('./message.js'),
    Platform        = mess.MessagePlatform,
    Message         = mess.Message,
    MessageStatus   = mess.MessageStatus;

(function (api) {

	var messageId = function(message) {
		return common.db.ObjectID(message.id.split('|')[0]);
	};

	var appId = function(message) {
		return common.db.ObjectID(message.id.split('|')[1]);
	};

	var appUsersFields = function(pushlyMessage) {
		if (pushlyMessage.credentials.platform === Platform.APNS) {
			if (pushlyMessage.test) {
				return [common.dbUserMap.tokens + '.' + common.dbUserMap.apn_dev, common.dbUserMap.tokens + '.' + common.dbUserMap.apn_adhoc];
			} else {
				return [common.dbUserMap.tokens + '.' + common.dbUserMap.apn_prod];
			}
		} else if (pushlyMessage.credentials.platform === Platform.GCM) {
            if (pushlyMessage.test) {
                return [common.dbUserMap.tokens + '.' + common.dbUserMap.gcm_test];
            } else {
                return [common.dbUserMap.tokens + '.' + common.dbUserMap.gcm_prod];
            }
		}

        return [];
	};

	if (cluster.isWorker) {
	    api.pushlyCallbacks = {
            count: function(message, query, callback){
                var fields = appUsersFields(message), filter = {}, i, finalQuery = {$or: []}, $or = finalQuery.$or;

                for (var any in query.conditions) {
                    finalQuery = {$and: [_.extend({}, query.conditions), {$or: []}]};
                    $or = finalQuery.$and[1].$or;
                    break;
                }

                var field = common.dbUserMap.tokens + '.' + message.credentials.id.split('.')[0];

                var obj = {};
                obj[field] = {$exists: true};
                $or.push(obj);

                filter[field] = 1;

                // for (i in fields) {
                //     var obj = {};
                //     obj[fields[i]] = {$exists: true};
                //     $or.push(obj);
                // }
                // for (i in fields) filter[fields[i]] = 1;

                if (message.content.messagePerLocale) {
                    filter[common.dbUserMap.lang] = 1;
                }

                common.db.collection('app_users' + query.appId).find(finalQuery).count(callback);
            },
	    	stream: function(message, query, callback){
	    		var fields = appUsersFields(message), filter = {}, count = 0, i, finalQuery = {$or: []}, $or = finalQuery.$or;

                for (var any in query.conditions) {
                    finalQuery = {$and: [_.extend({}, query.conditions), {$or: []}]};
                    $or = finalQuery.$and[1].$or;
                    break;
                }

               var field = common.dbUserMap.tokens + '.' + message.credentials.id.split('.')[0];

               var obj = {};
               obj[field] = {$exists: true};
               $or.push(obj);

               filter[field] = 1;
       //          for (i in fields) {
       //              var obj = {};
       //              obj[fields[i]] = {$exists: true};
       //              $or.push(obj);
       //          }
	    		// for (i in fields) filter[fields[i]] = 1;

                if (message.content.messagePerLocale) {
                    filter[common.dbUserMap.lang] = 1;
                }

	    		common.db.collection('app_users' + query.appId).find(finalQuery, filter).batchSize(common.config.push.batch).each(function(err, user){
	    			if (err) console.log(err);
	    			else if (user) {

                        count++;
                        callback(common.dot(user, field), user[common.dbUserMap.lang]);

                        // for (var i in fields) {
                        //     if (common.dot(user, fields[i])) {
                        //         count++;
                        //         callback(common.dot(user, fields[i]), user[common.dbUserMap.lang]);
                        //     }
                        // }

	    			} else {
	    				if (count === 0) {
                            console.log('Aborting message because no users is found');
                            pushly.abort(message);
                        }
	    			}
	    		});
	    	},
	        onInvalidToken: function(message, tokens, error) {
	    		var id = messageId(message), app = appId(message);
	    		common.db.collection('messages').findOne(id, function(err, m){
	    			if (m) {
	    				var $unset = {}, unsetQuery = {}, unset = [], update = [], i, fields = [common.dbUserMap.tokens + '.' + message.credentials.id.split('.')[0]]/*appUsersFields(message)*/;

	    				for (i = tokens.length - 1; i >= 0; i--) {
	    					var token = tokens[i];
	    					if (token.good) {
	    						update.push(token);
	    					} else {
	    						unset.push(token.bad);
	    					}
	    				}

	    				if (unset.length) {
                            fields.forEach(function(field){
                                $unset[field] = 1;
                                unsetQuery[field] = {$in: unset};
                            });
		    				common.db.collection('app_users' + app).update(unsetQuery, {$unset: $unset});
	    				}

	    				for (i = update.length - 1; i >= 0; i--) for (var f = fields.length - 1; f >= 0; f--) {
	    					var field = fields[f], upd = update[i], query = {}, set = {};

	    					query[field] = upd.bad;
	    					set[field] = upd.good;
		    				common.db.collection('app_users' + app).update(query, {$set: set});
	    				}
	    			}
	    		});
	        }
	    };
        pushly.setCallbacks(api.pushlyCallbacks);
	}

    pushly.on('status', function(message){
        var id = messageId(message);
        common.db.collection('messages').findOne(id, function(err, m){
            if (m) {
                var previouslySent  = m.result.sent || 0;

                m.result.delivered	= m.result.delivered || 0;
                m.result.actioned	= m.result.actioned || 0;
                m.result.total 		= 0;
                m.result.processed 	= 0;
                m.result.sent 		= 0;
                m.result.status		= 0;

                for (var i = m.pushly.length - 1; i >= 0; i--) {
                    var push = m.pushly[i];

                    if (push.id === message.id) {
                        push.result = message.result;
                        if (push.result.error) {
                            m.result.error = push.result.error;
                        }
                    }

                    m.result.total 		+= push.result.total;
                    m.result.processed 	+= push.result.processed;
                    m.result.sent 		+= push.result.sent;
                    m.result.status		|= push.result.status;
                }

                var update = {
                    $set: {
                        'pushly.$.result': message.result,
                        result: m.result
                    }
                };
                if (!m.sent && (m.result.status & MessageStatus.Done) > 0) {
                    update.$set.sent = new Date();
                }

                common.db.collection('messages').update({_id: id, 'pushly.id': message.id}, update);

                var count = m.result.sent - previouslySent;
                if (count) common.db.collection('apps').findOne(appId(message), function(err, app){
                    if (app){
                        var params = {
                            qstring: {
                                events: [
                                    { key: '[CLY]_push_sent', count: count, segmentation: {i: m._id } }
                                ]
                            },
                            app_id: app._id,
                            appTimezone: app.timezone,
                            time: common.initTimeObj(app.timezone)
                        };

                        events.processEvents(params);
                    }
                });
            }
        });
    });

    api.credentials = function(message, app) {
    	var array = [];
    	for (var i = message.platforms.length - 1; i >= 0; i--) {
    		var platform = message.platforms[i];

			if (platform == Platform.APNS) {
                if (message.test && app.apn && app.apn.test) {
                    array.push({
                        id: common.dbUserMap.apn_dev + '.' + app._id,
                        platform: pushly.Platform.APNS,
                        platformId: app.apn.id,
                        key: api.APNCertificatePath(app._id.toString(), true),
                        passphrase: app.apn.test.passphrase,
                        gateway: 'gateway.sandbox.push.apple.com',
                        port: 2195
                    });
                }

                // Ad Hoc build requires production certificate
                if (message.test && app.apn && app.apn.prod) {
                    array.push({
                        id: common.dbUserMap.apn_adhoc + '.' + app._id,
                        platform: pushly.Platform.APNS,
                        platformId: app.apn.id,
                        key: api.APNCertificatePath(app._id.toString(), false),
                        passphrase: app.apn.prod.passphrase,
                        gateway: 'gateway.push.apple.com',
                        port: 2195
                    });
                }

                // Normal production certificate case
                if (!message.test && app.apn && app.apn.prod) {
                    array.push({
                        id: common.dbUserMap.apn_prod + '.' + app._id,
                        platform: pushly.Platform.APNS,
                        platformId: app.apn.id,
                        key: api.APNCertificatePath(app._id.toString(), false),
                        passphrase: app.apn.prod.passphrase,
                        gateway: 'gateway.push.apple.com',
                        port: 2195
                    });
                }
			} else {
                if (app.gcm) {
                    array.push({
                        id: (message.test ? common.dbUserMap.gcm_test : common.dbUserMap.gcm_prod) + '.' + app._id,
                        platform: pushly.Platform.GCM,
                        platformId: app.gcm.id,
                        key: app.gcm.key,
                    });
                }
			}
		}
		return array;
    };

    api.checkApp = function (params) {
        var argProps = {
                'appId':            { 'required': true,  'type': 'String'   },
                'platform':         { 'required': true,  'type': 'String'   },
                'test':             { 'required': false, 'type': 'Boolean'  },
            },
            options = {};

        if (!(options = common.validateArgs(params.qstring, argProps))) {
            common.returnMessage(params, 400, 'Not enough args');
            return false;
        }

        api.check(options.appId, options.platform, options.test, function(ok){
            common.returnOutput(params, {ok: ok});
        });
    };

    api.check = function (appId, platform, test, callback) {
        common.db.collection('apps').findOne(common.db.ObjectID(appId), function(err, app){
            if (app) {
                var message = new Message([app._id], ['Test app'])
                    .setId(new common.db.ObjectID())
                    .setMessage('Test message')
                    .addPlatform(platform)
                    .setTest(test),

                    fun = function(message){
                        var status = message.result.status;
                        if (message.id === pushlyMessage.id && (status & (MessageStatus.Done | MessageStatus.Error | MessageStatus.Aborted)) > 0) {
                            pushly.removeListener('status', fun);

                            var ok = (status & (MessageStatus.Error | MessageStatus.Aborted)) === 0;

                            if (!ok) {
                                var update = {$unset:{}};
                                if (platform === Platform.APNS) {
                                    if (test) update.$unset.test = 1;
                                    else update.$unset.prod = 1;
                                } else if (platform === Platform.GCM) {
                                    update.$unset['gcm.key'] = 1;
                                }

                                common.db.collection('apps').update({_id: app._id}, update, function(){
                                    callback(ok);
                                });
                            } else {
                                callback(ok);
                            }
                        }
                    },

                    pushlyMessage;


                var credentials = api.credentials(message, app);
                if (credentials.length) {
                    pushlyMessage = message.toPushly(credentials[0], ['test token, which we don\'t really care about'], [app._id, credentials.platform]);

                    pushly.on('status', fun);
                    pushly.push(pushlyMessage);
                } else {
                    callback(false);
                }
            } else {
                callback(false);
            }
        });
    };

    api.countAudience = function(params, callback) {
        var argProps = {
                'apps':             { 'required': true,  'type': 'Array'   },
                'platforms':        { 'required': true,  'type': 'Array'   },
                'conditions':       { 'required': false, 'type': 'Object'  },
                'test':             { 'required': false, 'type': 'Boolean' }
            },
            msg = {};

        if (!(msg = common.validateArgs(params.qstring.args, argProps))) {
            callback({code: 400, message: 'Not enough args'});
        }

        msg.apps = _.map(msg.apps, common.db.ObjectID);

        common.db.collection('apps').find({_id: {$in: msg.apps}}).toArray(function(err, apps){
            if (err || !apps || !apps.length) {
                callback(null, []);
            } else {
                var message = new Message(msg.apps, '')
                        .setId(new common.db.ObjectID())
                        .addPlatform(msg.platforms)
                        .setConditions(msg.conditions)
                        .setTest(msg.test),
                    counters = [];

                apps.forEach(function(app){
                    var credentials = api.credentials(message, app);

                    credentials.forEach(function(creds){
                        counters.push(function(clb){
                            var field = creds.id.split('.')[0],
                                match = {$match: {}},
                                group = {$group: {_id: '$' + common.dbUserMap.lang, count: {$sum: 1}}};
                            match.$match[common.dbUserMap.tokens + '.' + field] = {$exists: true};
                            for (var k in msg.conditions) {
                                match.$match[k] = msg.conditions[k];
                            }

                            common.db.collection('app_users' + app._id).aggregate([match, group], function(err, results){
                                clb(err, {field: field, results: results});
                            });
                        });
                    });
                });


                async.parallel(counters, function(err, all){
                    if (err) {
                        callback(err);
                    } else {
                        var TOTALLY = {TOTALLY: 0};
                        for (var i in all) {
                            var res = all[i], field = common.dbUserMap.tokens + '.' + res.field;
                            if (!TOTALLY[field]) TOTALLY[field] = {TOTALLY: 0};
                            for (var r in res.results) {
                                var result = res.results[r];

                                if (!TOTALLY[field][result._id]) TOTALLY[field][result._id] = result.count;
                                else TOTALLY[field][result._id] += result.count;

                                if (!TOTALLY[result._id]) TOTALLY[result._id] = result.count;
                                else TOTALLY[result._id] += result.count;

                                TOTALLY.TOTALLY += result.count;
                            }
                        }
                        callback(null, TOTALLY);
                    }
                });
            }
        });
    };

    api.getAudience = function (params) {
        api.countAudience(params, function(err, TOTALLY){
            if (err) {
                common.returnMessage(params, err.code, err.message);
            } else {
                common.returnOutput(params, TOTALLY);
            }
        });

        return true;
    };

    api.getAllMessages = function (params) {
        var query = {
            'deleted': {$exists: false}
        };

        if (!params.member.global_admin) {
            var ids = [];

            if (params.member.admin_of) {
                for (var i in params.member.admin_of) {
                    var id = params.member.admin_of[i];
                    if (id) {
                        ids.push(common.db.ObjectID(id));
                    }
                }
            }

            if (params.member.user_of)  {
                for (var i in params.member.user_of) {
                    var id = params.member.user_of[i];
                    if (id) {
                        ids.push(common.db.ObjectID(id));
                    }
                }
            }

            query.app = {$in: ids};
        }

        /*
         var pageNo = (params.qstring.args && params.qstring.args.page && common.isNumber(params.qstring.args.page))? params.qstring.args.page : 1;

         common.db.collection('messages').find(query).sort({created: -1}).skip((pageNo - 1) * 20).limit(20).toArray(function (err, msgs) {
         */

        common.db.collection('messages').find(query).sort({created: -1}).toArray(function (err, msgs) {
            if (!msgs || err) {
                common.returnOutput(params, {});
                return false;
            }

            common.returnOutput(params, packMessages(msgs));
            return true;
        });

        return true;
    };

    api.createMessage = function (params) {
        var argProps = {
                'type':                 { 'required': true,  'type': 'String'  },
                'apps':                 { 'required': true,  'type': 'Array'   },
                'platforms':            { 'required': true,  'type': 'Array'   },
                'messagePerLocale':     { 'required': false, 'type': 'Object'  },
                'locales':              { 'required': false, 'type': 'Object'  },
                'conditions':           { 'required': false, 'type': 'Object'  },
                'sound':                { 'required': false, 'type': 'String'  },
                'badge':                { 'required': false, 'type': 'Number'  },
                'url':                  { 'required': false, 'type': 'URL'     },
                'category':             { 'required': false, 'type': 'String'  },
                'contentAvailable':    	{ 'required': false, 'type': 'Boolean' },
                'newsstandAvailable':   { 'required': false, 'type': 'Boolean' },
                'collapseKey':          { 'required': false, 'type': 'String'  },
                'delayWhileIdle':       { 'required': false, 'type': 'Boolean' },
                'data':                 { 'required': false, 'type': 'Object'  },
                'test':                 { 'required': false, 'type': 'Boolean' }
            },
            msg = {};

        if (!(msg = common.validateArgs(params.qstring.args, argProps))) {
            common.returnOutput(params, {error: 'Not enough args'});
            return false;
        }

        if (['message', 'link', 'category', 'data', 'update', 'review'].indexOf(msg.type) === -1) {
            common.returnOutput(params, {error: 'Bad message type'});
            return false;
        }

        for (var platform in msg.platforms) if ([Platform.APNS, Platform.GCM].indexOf(msg.platforms[platform]) === -1) {
            common.returnOutput(params, {error: 'Bad message plaform "' + msg.platforms[plaform] + '", only "' + Platform.APNS + '" (APNS) and "' + Platform.GCM + '" (GCM) are supported'});
            return false;
        }

        if (msg.type !== 'data' && !msg.messagePerLocale) {
            common.returnOutput(params, {error: 'Messages of type other than "data" must have "messagePerLocale"'});
            return false;
        }

        if (msg.type === 'data' && !msg.data) {
            common.returnOutput(params, {error: 'Messages of type "data" must have "data" property'});
            return false;
        }

        if (msg.type === 'link' && !msg.url) {
            common.returnOutput(params, {error: 'Messages of type "link" must have valid URL in "url" property'});
            return false;
        }

        if (msg.type === 'category' && !msg.category) {
            common.returnOutput(params, {error: 'Messages of type "category" must have "category" property'});
            return false;
        }

        if (msg.type === 'update' && typeof params.qstring.args.update === 'boolean') {
            msg.update = '';
        }

        if (msg.type === 'review' && typeof params.qstring.args.review === 'boolean') {
            msg.review = '';
        }

        var message = {};
        for (var k in msg.messagePerLocale) {
            message[k.replace(/[\[\]]/g, '')] = msg.messagePerLocale[k];
        }

        msg.apps = _.map(msg.apps, function(app){ return common.db.ObjectID(app); });

        if (params.qstring.args.date) {
            if ((params.qstring.args.date + '').length == 10) {
                params.qstring.args.date *= 1000;
            }

            msg.date = moment.utc(params.qstring.args.date).toDate();
        } else {
            msg.date = null;
        }

        common.db.collection('apps').find({_id: {$in: msg.apps}}).toArray(function(err, apps) {
            if (err || !apps) {
                common.returnOutput(params, {error: 'Not such apps'});
            } else {
                if (adminOfApps(params.member, apps)) {

                    api.countAudience(params, function(err, TOTALLY){
                        if (!TOTALLY || !TOTALLY.TOTALLY || TOTALLY.TOTALLY.TOTALLY) { // :)
                            common.returnOutput(params, {error: 'No push enabled users found for the selected apps-platforms-test combinations'});
                        } else {
                            var message = new Message(msg.apps, _.pluck(apps, 'name'))
                                .setId(new common.db.ObjectID())
                                .setType(msg.type)
                                .setMessagePerLocale(msg.messagePerLocale)
                                .setLocales(msg.locales)
                                .setURL(msg.url)
                                .setUpdate(msg.update)
                                .setReview(msg.review)
                                .addPlatform(msg.platforms)
                                .setConditions(msg.conditions)
                                .setSound(msg.sound)
                                .setBadge(msg.badge)
                                .setTest(msg.test)
                                .setContentAvailable(msg.contentAvailable)
                                .setNewsstandAvailable(msg.newsstandAvailable)
                                .setCollapseKey(msg.collapseKey)
                                .setDelayWhileIdle(msg.delayWhileIdle)
                                .setData(msg.data)
                                .schedule(msg.date);

                            common.db.collection('messages').save(mess.cleanObj(message), function(err) {
                                if (err) {
                                    common.returnOutput(params, {error: 'Server db Error'});
                                } else {
                                    common.returnOutput(params, message);
                                }
                            });
                        }
                    });
                } else {
                    common.returnOutput(params, {error: 'Not an admin of all selected apps'});
                }
            }
        });
        return true;
    };

    api.deleteMessage = function (params) {
        var argProps = {
                'mid': { 'required': true, 'type': 'String', 'min-length': 24, 'max-length': 24 }
            },
            mid;

        if (!(mid = common.validateArgs(params.qstring, argProps).mid)) {
            common.returnMessage(params, 400, 'Not enough args');
            return false;
        }

        common.db.collection('messages').findOne({'_id': common.db.ObjectID(mid)}, function(err, message) {
            if (!message) {
                common.returnMessage(params, 404, 'Message not found');
                return false;
            }

            if ((message.result.status & MessageStatus.InProcessing) > 0) {
                message.pushly.forEach(function(pushlyMessage){
                    pushly.abort(pushlyMessage);
                });
                common.db.collection('messages').update({_id: message._id}, {$set: {'deleted': true}});
                message.deleted = true;
                common.returnOutput(params, message);
            } else {
                common.db.collection('messages').update({_id: message._id}, {$set: {'deleted': true}});
                common.returnOutput(params, message);
            }

            // TODO: need to delete analytics?

            return true;
        });

        return true;
    };

    api.refreshMessage = function (params) {
        var argProps = {
                'mid': { 'required': true, 'type': 'String', 'min-length': 24, 'max-length': 24 }
            },
            mid;

        if (!(mid = common.validateArgs(params.qstring, argProps).mid)) {
            common.returnMessage(params, 400, 'Not enough args');
            return false;
        }

        common.db.collection('messages').findOne({'_id': common.db.ObjectID(mid)}, function(err, message) {
            if (!message || (message.result.status & MessageStatus.Deleted) > 0) {
                common.returnMessage(params, 404, 'Message not found');
                return false;
            }

            common.returnOutput(params, message);

            return true;
        });

        return true;
    };

    api.processTokenSession = function(dbAppUser, params) {
        var $set = {}, $unset = {};

        if (params.qstring['locale']) {
            $set[common.dbUserMap['locale']] = params.qstring['locale'];
        }

        var token, field;
        if (typeof params.qstring['ios_token'] !== 'undefined' && typeof params.qstring.test_mode !== 'undefined') {
            token = params.qstring['ios_token'];
            field = common.dbUserMap.tokens + '.' + common.dbUserMap['apn_' + params.qstring.test_mode];
        } else if (params.qstring['android_token'] && typeof params.qstring.test_mode !== 'undefined') {
            token = params.qstring['android_token'];
            field = common.dbUserMap.tokens + '.' + common.dbUserMap['gcm_' + params.qstring.test_mode];
        }

        if (field) {
            if (token) {
                $set[field] = token;
                if (common.dot(dbAppUser, field) != token) {
                    common.db.collection('app_users' + params.app_id).update({'_id':params.app_user_id}, {$set: $set}, {upsert: true});

                    if (!dbAppUser[common.dbUserMap.tokens]) dbAppUser[common.dbUserMap.tokens] = {};
                    common.dot(dbAppUser, field, token);

                    usage.processChangedMessagingToken(dbAppUser, params);
                }
            } else {
                $unset[field] = 1;
                if (common.dot(dbAppUser, field)) {
                    common.db.collection('app_users' + params.app_id).update({'_id':params.app_user_id}, {$unset: $unset}, {upsert: false});
                }
            }
        }

    };

    function adminOfApp(member, app) {
        if (member.global_admin) {
            return true;
        } else {
            return member.admin_of && member.admin_of.indexOf(app._id.toString()) !== -1;
        }
    }

    function adminOfApps(member, apps) {
        var authorized = true;

        apps.forEach(function(app){
            authorized &= adminOfApp(member, app);
        });

        return authorized;
    }

    function packMessages(msgs) {
        var msgsObj = {};

        for (var i = 0; i < msgs.length ;i++) {
            msgsObj[msgs[i]._id] = msgs[i];
        }

        return msgsObj;
    }

    api.APNCertificateFile = function(appId, test) {
        return appId + '.' + (test ? 'test' : 'prod') + '.p12';
    };

    api.APNCertificatePath = function(appId, test) {
        return __dirname + '/../../../frontend/express/certificates/' + api.APNCertificateFile(appId, test);
    };

}(api));

module.exports = api;
