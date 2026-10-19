sub init()
    m.how = m.top.findNode("how")
    m.code = m.top.findNode("code")
    m.hint = m.top.findNode("hint")
    m.poll = m.top.findNode("poll")
    m.retry = m.top.findNode("retry")
    m.poll.observeField("fire", "onPoll")
    m.retry.observeField("fire", "requestCode")
    m.how.text = "On your phone or computer, open Marquee → Account → Watch on a TV (or go to " + m.global.server + "/#/link) and enter this code:"
    requestCode()
end sub

sub requestCode()
    m.poll.control = "stop"
    name = "Roku"
    model = CreateObject("roDeviceInfo").GetModelDisplayName()
    if model <> invalid and model <> "" then name = model
    mqApi("/api/devices/pair", "onPair", "POST", { name: name })
end sub

sub onPair(event as Object)
    r = event.getData()
    if r.status = 200 and r.data <> invalid then
        m.pairId = r.data.id
        code = r.data.code
        m.code.text = Left(code, 3) + " " + Mid(code, 4)
        m.poll.control = "start"
    else
        m.code.text = "······"
        m.hint.text = "Can't reach Marquee (" + r.error + "). Trying again… Press ✱ to use a different server."
        m.retry.control = "start"
    end if
end sub

sub onPoll()
    if m.pairId = invalid then return
    mqApi("/api/devices/pair/" + m.pairId, "onPollResult")
end sub

sub onPollResult(event as Object)
    r = event.getData()
    if r.status = 404 then
        requestCode() ' expired: a fresh code
        return
    end if
    d = r.data
    if r.status = 200 and d <> invalid and d.status = "linked" then
        m.poll.control = "stop"
        mqWrite("token", d.token)
        m.global.token = d.token
        if d.user <> invalid then
            mqWrite("username", d.user.username)
            m.global.username = d.user.username
        end if
        m.top.navigate = { screen: "HomeScreen", reset: true }
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if press and key = "options" then
        m.poll.control = "stop"
        mqDelete("server")
        m.global.server = ""
        m.top.navigate = { screen: "SetupScreen", reset: true }
        return true
    end if
    return false
end function
