sub init()
    m.finished = false
    word = m.top.findNode("word")
    ' Centred: the word's size (a guess if the box isn't measured yet).
    size = word.boundingRect()
    w = size.width
    h = size.height
    if w < 100 then w = 900
    if h < 50 then h = 200
    x0 = Int((1920 - w) / 2)
    y0 = Int((1080 - h) / 2)
    word.translation = [x0, y0]
    ' The light comes in from the left of the word and leaves past its right: a soft wide band
    ' with a brighter narrow one in its middle.
    slit(m.top.findNode("glow"), "glow", 220, x0, y0, w, h)
    slit(m.top.findNode("haze"), "haze", 110, x0, y0, w, h)
    slit(m.top.findNode("shine"), "shine", 44, x0, y0, w, h)

    ' The server's opening sound (an admin can choose their own), or the channel's own when there's
    ' no server yet or it can't be reached.
    m.sound = m.top.findNode("sound")
    server = m.global.server
    if server <> invalid and server <> "" then
        m.sound.observeField("state", "onSound")
        playSound(server + "/sounds/intro.mp3")
    else
        playSound("pkg:/sounds/intro.mp3")
    end if

    m.anim = m.top.findNode("anim")
    m.anim.observeField("state", "onAnim")
    m.anim.control = "start"
end sub

sub playSound(url as String)
    sound = CreateObject("roSGNode", "ContentNode")
    sound.url = url
    m.sound.content = sound
    m.sound.control = "play"
end sub

sub onSound()
    if m.sound.state <> "error" then return
    m.sound.unobserveField("state")
    playSound("pkg:/sounds/intro.mp3")
end sub

' One slit of light, `width` wide, crossing the word (x0, y0, w, h); the slits share a middle.
sub slit(group as Object, name as String, width as Integer, x0 as Integer, y0 as Integer, w as Float, h as Float)
    group.clippingRect = [0, 0, width, h]
    fromX = Int(x0 - 150 - width / 2)
    toX = Int(x0 + w + 150 - width / 2)
    group.translation = [fromX, y0]
    m.top.findNode(name + "Move").keyValue = [[fromX, y0], [fromX, y0], [toX, y0], [toX, y0]]
    m.top.findNode(name + "WordMove").keyValue = [[x0 - fromX, 0], [x0 - fromX, 0], [x0 - toX, 0], [x0 - toX, 0]]
    m.top.findNode(name + "Word").translation = [x0 - fromX, 0]
end sub

sub onAnim()
    if m.anim.state = "stopped" then finish(false)
end sub

' skipped: a key ended it early (the sound stops too).
sub finish(skipped as Boolean)
    if m.finished then return
    m.finished = true
    m.anim.control = "stop"
    if skipped then m.sound.control = "stop"
    m.top.visible = false
    m.top.done = true
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if press then finish(true)
    return true
end function
