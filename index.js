#!/usr/bin/env node
const {RTMClient, WebClient} = require('@slack/client');
const config = require('./config');

const START_TS_DIFF = config.START_TS_DIFF;
const END_TS_DIFF = config.END_TS_DIFF;
const TS_DIFF_TOLERANCE = config.TS_DIFF_TOLERANCE;

const MENTION_REGEX = /<@([A-Z0-9]+)>/g;
const EDITED_FALLBACK_TAG = "slackportal_edited";
const EMOJI_FALLBACK_TAG = "slackportal_emoji";

// Simple log function
var log = {
  info: s => console.error('\x1b[37m[Info]: %s\x1b[0m', s), // white
  warn: s => console.error('\x1b[33m[Warn]: %s\x1b[0m', s), // yellow
  error: s => console.error('\x1b[31m[Error]: %s\x1b[0m', s), // red
  fatal: s => {
    console.error('\x1b[1m\x1b[31m[Fatal]: %s\x1b[0m', s); // bold red
    console.trace(s);
    process.exit(1);
  }
};

function getChannelId(web, channel_name) {
  return new Promise(resolve => {
    web.channels.list()
      .then(res => {
        for (channel of res.channels)
          if (channel.name == channel_name)
            return resolve(channel.id);

        log.fatal(`Channel not found: ${channel_name}`);
      });
  });
}

function getUser(web, user_id) {
  return new Promise(resolve => {
    if (user_id in web.cached_users) {
      log.info(`user id ${user_id} is in the cache, resolved to ${web.cached_users[user_id].name}`);
      return resolve(web.cached_users[user_id]);
    }

    log.info(`user id ${user_id} cache missed, resolving...`);
    web.users.info({user: user_id})
      .then(res => {
        web.cached_users[user_id] = res.user;
        log.info(`user id ${user_id} resolved to ${web.cached_users[user_id].name}`);
        return resolve(web.cached_users[user_id]);
      }).catch(error => {
        log.error(`user id ${user_id} not found!`);
      });
  });
}

function preprocessUserMentions(web, text) {
  return new Promise(resolve => {
    log.info(`preprocess mention string ${text}`);
    var raw_ids = text.match(MENTION_REGEX);
    if (raw_ids === null) {
      log.info(`there is nothing to do`);
      return resolve(text);
    }
    var get_users = raw_ids.map(raw_id => {
      // maybe use exec at the beginning
      var id = new RegExp(MENTION_REGEX).exec(raw_id)[1];
      return getUser(web, id);
    });
    // Replace user.id with name in text
    Promise.all(get_users)
      .then(users => {
        for (user of users)
          text = text.replace(user.id, getNameFromUser(user));
        log.info(`preprocess compeleted: ${text}`);
        return resolve(text);
      });
  });
}

function generateEmojiAttachment(local_web, res) {
  return new Promise(resolve => {
    var users = {};
    for (reaction of (res.message.reactions || []))
      for (user_id of reaction.users)
        users[user_id] = users[user_id] || getUser(local_web, user_id);
    var users_array = [];
    for (let user_id in users)
      users_array.push(users[user_id]);
    Promise.all(users_array).then((resolved_user_array) => {
      for (let user of resolved_user_array)
        users[user.id] = user;
      var emoji_summary = [];
      var emoji_detail = [];
      for (reaction of (res.message.reactions || [])) {
        emoji_summary.push(`:${reaction.name}: ${reaction.count}`);
        var names = [];
        for (user_id of reaction.users)
          names.push(getNameFromUser(users[user_id]));
        emoji_detail.push(reaction.name + ': ' + names.join(', '));
      }
      var emoji_summary_text = emoji_summary.join(' ');
      var emoji_detail_text = emoji_detail.join(' | ');
      return resolve({
        fallback: EMOJI_FALLBACK_TAG,
        text: emoji_summary_text,
        footer: emoji_detail_text,
      });
    });
  });
}

function removeMentionTag(text) {
  /*
   * User mention: <@[A-Z0-9]{9}>
   * URL: <http://example.com>
   */
  let pattern = /<@([A-Z0-9]*)>/g
  let result = undefined;
  let new_text = text;
  while (result = pattern.exec(text)) {
    let with_quotes = result[0];
    let without_quotes = result[1];
    new_text = new_text.replace(with_quotes, without_quotes);
  }
  return new_text;
}

function getNameFromUser(user) {
  return user.profile.display_name || user.profile.real_name || user.name;
}

function searchMessage(web, channel_id, text, start_ts, end_ts) {
  return new Promise(resolve => {
    web.channels.history({
      channel: channel_id,
      oldest: start_ts.toString(),
      latest: end_ts.toString(),
      inclusive: true
    }).then(res => {
      log.info(`search result: ${JSON.stringify(res.messages.reverse())}`);
      // always return the earliest message
      var raw_messages = res.messages.reverse().map(message =>
        preprocessUserMentions(web, message.text)
          .then(preprocessed_text => {
            message.text = removeMentionTag(preprocessed_text);
            return message;
          })
      );
      Promise.all(raw_messages)
        .then(messages => {
          for (message of messages) {
            message.text = removeMentionTag(message.text);
            if (text === null || message.text === text) {
              log.info(`message found: ${JSON.stringify(message)}`);
              var ts = parseFloat(message.ts);
              var start_diff = Math.abs(ts - start_ts);
              var end_diff = Math.abs(ts - end_ts);
              log.info(`start_ts_diff=${start_diff}, end_ts_diff=${end_diff}`);
              if (start_ts != end_ts && start_diff < TS_DIFF_TOLERANCE)
                log.warn(`the time difference of start_ts is too small (${start_diff} secs). consider increasing START_TS_DIFF`);
              if (start_ts != end_ts && end_diff < TS_DIFF_TOLERANCE)
                log.warn(`the time difference of end_ts is too small (${end_diff} secs). consider increasing END_TS_DIFF`);
              return resolve(message);
            }
          }
          log.error(`cannot find this message in the result!`);
          log.error(`start_ts = ${start_ts}, end_ts = ${end_ts}, text = ${text}`);
          log.error(`it is possible remote channel update the message`);
          log.error(`if not, please consider modifying the START_TS_DIFF and END_TS_DIFF`);
        });
    });
  });
}

function createPortal(local_web, local_rtm, remote_web, local_channel_id, remote_channel_id) {
  var reactionHandler = event => {
    if (event.item.channel !== local_channel_id)
      return;
    var ts = event.item.ts;
    searchMessage(local_web, local_channel_id, null, ts, ts)
      .then(message => {
        local_web.reactions.get({channel: local_channel_id, timestamp: message.ts})
          .then(res => {
            generateEmojiAttachment(local_web, res)
              .then(emoji_attachment => {
                var start_ts = parseFloat(ts) - START_TS_DIFF;
                var end_ts = parseFloat(ts) + END_TS_DIFF;
                searchMessage(remote_web, remote_channel_id, message.text, start_ts, end_ts)
                  .then(remote_message => {
                    log.info(`forwading the reaction to remote......`);
                    var attachments = remote_message.attachments || [];
                    var is_found = false;
                    for (let i = 0; i < attachments.length; i++) {
                      if (attachments[i].fallback === EMOJI_FALLBACK_TAG) {
                        attachments[i] = emoji_attachment;
                        is_found = true;
                      }
                    }
                    if (!is_found)
                      attachments.push(emoji_attachment);
                    remote_web.chat.update({
                      channel: remote_channel_id,
                      text: remote_message.text,
                      ts: remote_message.ts,
                      attachments: attachments
                    });
                  });
              });
          });
      });
  };
  local_rtm.on('reaction_removed', reactionHandler);
  local_rtm.on('reaction_added', reactionHandler);
  local_rtm.on('message', event => {
    if (event.channel !== local_channel_id)
      return;

    log.info(`receive event in current local channel: ${JSON.stringify(event)}`);
    switch (event.subtype) {
      case 'message_changed':
      case 'message_deleted':
        if (event.previous_message.subtype === 'bot_message') {
          log.info('ignored remote updates local bot message');
          break;
        }
        if (event.previous_message.text === (event.message ? event.message.text: undefined)) {
          log.info('ignored remote updates local attachments of users message');
          break;
        }
        if (event.subtype === 'message_deleted') {
          var updateMessage = message => remote_web.chat.delete({channel: remote_channel_id, ts: message.ts});
        } else {
          var text = event.message.text;
          var updateMessage = message => {
            var attachments = message.attachments || [];
            var is_found = false;
            for (let attachment of attachments) {
              if (attachment.fallback === EDITED_FALLBACK_TAG) {
                attachment.ts = event.ts;
                is_found = true;
              }
            }
            if (!is_found)
              attachments.unshift({"fallback": EDITED_FALLBACK_TAG, "text": "", "footer": "(edited)", "ts": event.ts});
            remote_web.chat.update({
              channel: remote_channel_id,
              ts: message.ts,
              text: text,
              attachments: attachments
            });
          }
        }
        var start_ts = parseFloat(event.previous_message.ts) - START_TS_DIFF;
        var end_ts = parseFloat(start_ts) + END_TS_DIFF;
        var prev_text = event.previous_message.text;
        log.info(`message update event: ${prev_text} => ${event.message ? event.message.text: '(deleted)'}`);
        searchMessage(remote_web, remote_channel_id, prev_text, start_ts, end_ts).then(updateMessage);
        break;
      case 'message_replied':
        log.info(`ignored message replied event`);
        // TODO: cached thread_ts and msg to save the time retrieving the text of response
        break;
      case undefined:
        if (event.thread_ts === undefined) { // normal message
          log.info(`forwarding normal message ${event.text}......`);
          Promise.all([
            getUser(local_web, event.user),
            preprocessUserMentions(local_web, event.text)
          ]).then(([user, text]) => {
             log.info(`forwarding to remote......`);
             remote_web.chat.postMessage({
               channel: remote_channel_id,
               text: text,
               as_user: false,
               icon_url: user.profile.image_48,
               link_names: true,
               username: getNameFromUser(user),
             });
          });
        } else { // thread reply
          log.info(`forwarding thread reply message ${event.text}......`);
          var ts = event.thread_ts;
          Promise.all([
            getUser(local_web, event.user),
            searchMessage(local_web, local_channel_id, null, ts, ts)
          ]).then(([user, message]) => {
            log.info(`retrieved local thread text ${message.text}......`);
            var start_ts = parseFloat(message.ts) - START_TS_DIFF;
            var end_ts = parseFloat(start_ts) + END_TS_DIFF;
            searchMessage(remote_web, remote_channel_id, message.text, start_ts, end_ts)
              .then(thread_message => {
                log.info(`forwading the reply to remote......`);
                remote_web.chat.postMessage({
                  channel: remote_channel_id,
                  text: event.text,
                  as_user: false,
                  icon_url: user.profile.image_48,
                  link_names: true,
                  username: getNameFromUser(user),
                  thread_ts: thread_message.ts,
                });
              });
          });
        }
        break;
      case 'bot_message':
        // Do nothing to prevent infinite messages sent back and forth
        log.info('ignored bot message to prevent messages sent back and forth');
        break;
      default:
        log.warn(`unknown event.subtype ${event.subtype}, ignored`);
    }
  });
}

async function main() {
  log.info(`local web client connecting...`);
  const local_web = new WebClient(config.local_oauth_token);
  log.info(`local rtm client connecting...`);
  const local_rtm = new RTMClient(config.local_bot_token);
  log.info(`local rtm start...`);
  local_rtm.start();

  log.info(`remote web client connecting...`);
  const remote_web = new WebClient(config.remote_oauth_token);
  log.info(`remote rtm client connecting...`);
  const remote_rtm = new RTMClient(config.remote_bot_token);
  log.info(`remote rtm start...`);
  remote_rtm.start();

  log.info(`retrieve local/remote channel ids...`);
  const [local_channel_id, remote_channel_id] = await Promise.all([
    getChannelId(local_web, config.local_channel_name),
    getChannelId(remote_web, config.remote_channel_name)
  ]);

  log.info(`local channel #${config.local_channel_name} ID: ${local_channel_id}`);
  log.info(`remote channel #${config.remote_channel_name} ID: ${remote_channel_id}`);
  log.info(`listening local/remote rtm events...`);

  local_web.cached_users = {};
  remote_web.cached_users = {};
  //TODO: cached local messages, so thread reply can be more efficient
  //var local_messages = {};
  createPortal(local_web, local_rtm, remote_web, local_channel_id, remote_channel_id);
  createPortal(remote_web, remote_rtm, local_web, remote_channel_id, local_channel_id);
}

main();
