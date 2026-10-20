sub init()
    m.top.backgroundColor = "0x0B0B0BFF"
    m.top.backgroundUri = ""
    m.global.addFields({ server: mqRead("server"), token: mqRead("token"), username: mqRead("username"), mediaKey: mqRead("mediaKey") })
    ' Pictures and videos are fetched with a media key rather than the sign-in itself (see
    ' mqMediaUrl). A new sign-in (linking, switching profile) gets a new key; signing out drops it.
    m.global.observeField("token", "onToken")
    if m.global.token <> "" then mqApi("/api/auth/media-key", "onMediaKey")
    m.stack = []
    m.screens = m.top.findNode("screens")
    ' Only the screen on top may have the highlight (see onScreensFocus).
    m.screens.observeField("focusedChild", "onScreensFocus")
    ' The intro plays over the first screen, which starts loading straight away underneath; it
    ' keeps the keys (any key skips it) until it's over.
    m.intro = m.top.createChild("IntroScreen")
    m.intro.observeField("done", "onIntroDone")
    m.intro.setFocus(true)
    if m.global.server = "" then
        show("SetupScreen", {}, false, true)
    else if m.global.token = "" then
        show("PairScreen", {}, false, true)
    else
        ' "Who's watching?" first (it goes straight on to Home when there's nobody to switch to).
        show("ProfilesScreen", { atStart: true }, false, true)
    end if
end sub

' (The finished intro stays in the scene, hidden, so its sound can play to the end.)
sub onIntroDone()
    m.intro = invalid
    if m.stack.Count() > 0 then m.stack.Peek().setFocus(true)
end sub

sub onToken()
    m.global.mediaKey = ""
    mqDelete("mediaKey")
    if m.global.token <> "" then mqApi("/api/auth/media-key", "onMediaKey")
end sub

sub onMediaKey(event as Object)
    r = event.getData()
    if r.status = 200 and r.data <> invalid and r.data.key <> invalid then
        m.global.mediaKey = mqStr(r.data.key)
        mqWrite("mediaKey", m.global.mediaKey)
    end if
end sub

sub show(name as String, params as Object, replace as Boolean, reset as Boolean)
    if reset then
        while m.stack.Count() > 0
            m.screens.removeChild(m.stack.Pop())
        end while
    else if replace and m.stack.Count() > 0 then
        m.screens.removeChild(m.stack.Pop())
    end if
    if m.stack.Count() > 0 then m.stack.Peek().visible = false
    screen = CreateObject("roSGNode", name)
    screen.observeField("navigate", "onNavigate")
    m.stack.Push(screen)
    m.screens.appendChild(screen)
    screen.params = params
    if m.intro = invalid then screen.setFocus(true)
end sub

' A screen's request: { screen, params, replace, reset } to open one, or { back: true }.
sub onNavigate(event as Object)
    nav = event.getData()
    if nav = invalid then return
    if mqIsTrue(nav.back) then
        goBack()
        return
    end if
    params = nav.params
    if params = invalid then params = {}
    show(nav.screen, params, mqIsTrue(nav.replace), mqIsTrue(nav.reset))
end sub

' The screens under the top one are hidden but still there: if something in one of them takes the
' focus (a late reply, a key on its way up from a menu that opened another screen), keys would go to
' a screen you can't see. Give it back to the one on top.
sub onScreensFocus()
    if m.stack.Count() = 0 or not m.screens.isInFocusChain() then return
    if m.intro <> invalid then
        m.intro.setFocus(true)
        return
    end if
    top = m.stack.Peek()
    if not top.isInFocusChain() then top.setFocus(true)
end sub

function goBack() as Boolean
    if m.stack.Count() <= 1 or m.intro <> invalid then return false
    m.screens.removeChild(m.stack.Pop())
    top = m.stack.Peek()
    top.visible = true
    top.refresh = true
    top.setFocus(true)
    return true
end function

function onKeyEvent(key as String, press as Boolean) as Boolean
    if press and key = "back" then return goBack()
    return false
end function
