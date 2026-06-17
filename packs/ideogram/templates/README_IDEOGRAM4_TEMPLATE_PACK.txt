IDEOGRAM 4 JSON TEMPLATE PACK
README BY AITREPRENEUR

Thank you for downloading this Ideogram 4 template pack.

This pack was created for the Ideogram 4 Prompt Builder KJNode inside ComfyUI. The goal is to give you ready-to-use JSON templates that you can quickly load, modify, and use to generate high-quality images with strong layout control.

Each template comes with:

1. A .json file
   This is the actual Ideogram 4 Prompt Builder template.

2. A .png preview image
   This is only a visual preview so you can quickly see what the template is meant to do.

The .json and .png files use the same name so you can easily find the matching preview for each template.


============================================================
HOW TO INSTALL THE TEMPLATES
============================================================

1. Find your ComfyUI folder.

For the Windows portable version, the folder is usually something like:

ComfyUI_windows_portable\ComfyUI\user\default\kjnodes\ideogram4\templates

2. Copy all .json files from this pack into that folder.

3. Keep the .png preview images anywhere you want.

The preview images are not required by ComfyUI, but they are useful so you can quickly see what each template does.

4. Restart ComfyUI, or refresh the node/template list if your workflow supports it.

5. Open the Ideogram 4 Prompt Builder KJNode.

6. Select one of the templates from the template dropdown.

7. Edit the text inside the node to customize the template.


============================================================
IMPORTANT FOLDER PATH
============================================================

Default KJNodes template folder:

ComfyUI_windows_portable\ComfyUI\user\default\kjnodes\ideogram4\templates

If you are using a different ComfyUI installation, your path may be different.

The important part is:

ComfyUI\user\default\kjnodes\ideogram4\templates


============================================================
HOW TO USE THE TEMPLATES
============================================================

Each JSON template is built with the same basic structure:

{
  "high_level_description": "...",
  "compositional_deconstruction": {
    "background": "...",
    "elements": [...]
  }
}

The "high_level_description" explains the full image idea.

The "background" explains the general scene, environment, color palette, lighting, and overall mood.

The "elements" section contains the important objects, characters, text blocks, products, panels, UI pieces, or layout areas.

Many elements include a "bbox" value.


============================================================
WHAT IS A BBOX?
============================================================

A bbox is a placement box that tells the model where an element should appear.

The bbox format used by the KJNode is:

[top, left, bottom, right]

The values go from 0 to 1000.

Example:

"bbox": [100, 200, 900, 500]

This means:

top = 100
left = 200
bottom = 900
right = 500

So the element starts near the top at 100, starts from the left at 200, ends near the bottom at 900, and ends on the right at 500.

For a vertical character column in a wide image, a bbox might look like:

[120, 20, 970, 285]

For a centered portrait subject in a vertical image, a bbox might look like:

[100, 180, 930, 820]


============================================================
IMPORTANT BBOX TIPS
============================================================

1. Do not use too many bboxes for one subject.

If you are describing one person, use one main bbox for the whole person.

Bad:
One bbox for face
One bbox for hair
One bbox for clothes
One bbox for hands
One bbox for lighting

Better:
One bbox for the full subject, with all details in the description.

2. Use extra bboxes only for separate important objects.

Good examples:
One bbox for the subject
One bbox for an eye patch
One bbox for a product
One bbox for a text title
One bbox for a separate character

3. Avoid putting many bboxes on top of each other.

If too many boxes overlap, the result can become messy, or the KJNode preview can become unreadable.

4. For character groups, use vertical columns.

For example, in a wide image with 4 people:

Left character:
[120, 20, 970, 285]

Center-left character:
[95, 285, 985, 560]

Center-right character:
[120, 555, 970, 790]

Right character:
[125, 780, 960, 980]

5. For posters and covers, reserve clear zones.

Example:
Top zone for title
Middle zone for character
Bottom zone for subtitle or call to action

6. If your result has overlapping text, increase the empty space between text bboxes or remove some text elements.


============================================================
RECOMMENDED RESOLUTIONS
============================================================

Use the resolution that matches the template.

Most vertical poster templates:

1440x2560

Wide landscape templates:

2560x1440

Square asset sheets:

2048x2048

Ultrawide or special layout templates:

2880x1440 or 2048x1024, depending on your setup

If a template looks too cramped, try a larger resolution with the same aspect ratio.


============================================================
WHAT IS INCLUDED
============================================================

This pack contains 25 high-quality Ideogram 4 JSON templates covering many different use cases.

The exact file names may depend on the final version of the pack, but the pack includes templates for:

1. Film poster design
2. T-shirt graphic print design
3. Book cover design
4. Experimental music or cyberpunk editorial poster
5. Comic book cover design
6. Company logo design concepts
7. Personal branding sheet
8. Social media branding kit
9. Product or branding showcase
10. Promotional design layout
11. Food promotion advertisement
12. Real estate promotion poster
13. Restaurant or fast food menu poster
14. Original product advertisement
15. Creator or tech brand promotional poster
16. 2D character sheet
17. 3D character sheet
18. Game item asset sheet
19. Magazine cover design
20. Trading card design
21. Painting style scene
22. Anime magazine cover
23. Cyberpunk anime editorial cover
24. Editorial beauty photoshoot
25. Mixed-style group vacation photo

The goal is not to give you thousands of templates.

The goal is to give you a strong variety of high-quality templates that are easy to understand, easy to edit, and useful for many different image generation use cases.


============================================================
HOW TO EDIT A TEMPLATE
============================================================

You can edit almost everything.

Good things to change:

Subject
Character gender
Hair color
Clothing
Background
Title text
Product name
Color palette
Mood
Lighting
Style
Objects
Logo names
Text labels
Bbox positions

For example, in a food ad template, you can replace burgers with:

Pizza
Sushi
Tacos
Ice cream
Coffee
Fried chicken
Donuts

In a magazine cover template, you can replace:

Magazine title
Cover model
Main story
Side blurbs
Color palette
Fashion style

In a character sheet template, you can replace:

Character name
Outfit
Species
Art style
Accessories
Weapons
Color palette


============================================================
HOW TO KEEP RESULTS CLEAN
============================================================

1. Do not over-edit everything at once.

Change one or two major things first, test the result, then refine.

2. Keep the structure clean.

If the template uses 5 elements, do not immediately turn it into 20 elements unless you know what you are doing.

3. If the layout breaks, simplify.

Remove unnecessary elements and keep only the most important parts.

4. If the text is bad, make it shorter.

Image models usually handle short text better than long text.

Good:
"ORDER NOW"
"COMING THIS FALL"
"MIDNIGHT SOVEREIGN"

Riskier:
Very long sentences
Long paragraphs
Too many tiny labels

5. If a subject style is wrong, make the style instruction stronger.

Example for a real photo subject:

"rendered as an actual live-action photograph, not anime, not illustration, not painterly, not cel-shaded"

Example for anime subjects:

"rendered in high-quality Japanese anime illustration style only, clean line art, cel shading, not photographic, not realistic"


============================================================
KNOWN LIMITATIONS
============================================================

1. Same seed does not always mean identical images on different machines.

If you run the same workflow locally and on RunPod, the result can still be slightly different.

This can happen because of:
Different GPU
Different drivers
Different PyTorch versions
Different CUDA versions
Different ComfyUI versions
Different nodes
Different backend settings
Non-deterministic operations

Small differences are normal.

2. Text can still fail sometimes.

Ideogram 4 is strong with text, but long or tiny text may still break.

Use short, bold, readable text when possible.

3. Complex multi-character prompts are harder.

If you ask for many characters in different styles, the model may blend the styles.

To improve this:
Use separate bboxes
Keep each subject description very clear
Use strong style locking words
Avoid overlapping bboxes too much

4. Character turnarounds are hard.

Front, 3/4, side, and back views can sometimes drift in style or design.

To improve this:
Keep the sheet simple
Use fewer panels
Make each view description strict
Avoid extra portrait, gear, expression, and palette panels if the layout becomes messy

5. Too many elements can make the image worse.

More detail is not always better.

A clean template with 3 to 6 strong elements often works better than a huge template with 20 overlapping elements.


============================================================
IF YOU GET "NOT A VALID IDEOGRAM 4 CAPTION JSON"
============================================================

Check these things:

1. The JSON must start with:

{
  "high_level_description": "...",
  "compositional_deconstruction": {
    ...
  }
}

2. Make sure the key name is exactly:

"compositional_deconstruction"

Not:
"compositional_deconstructionl"
"composition_deconstruction"
"compositional deconstruction"

3. Use double quotes.

Correct:
"text": "ORDER NOW"

Wrong:
'text': 'ORDER NOW'

4. Do not leave trailing commas.

Wrong:
{
  "text": "ORDER NOW",
}

5. Check that every opening bracket has a closing bracket.

6. If you edited the JSON manually and it breaks, paste it into any JSON validator to find the mistake.


============================================================
SAFE USE NOTES
============================================================

These templates use original fictional names, original fictional brands, and generic character archetypes.

They are not meant to copy real brands, real people, or copyrighted characters.

You can modify them for your own use, but be careful if you intentionally add real brands, famous characters, celebrity likenesses, copyrighted logos, or protected designs.

For Patreon or public sharing, it is safer to keep the templates original and generic.


============================================================
BEST PRACTICES
============================================================

For best results:

Use the recommended resolution.
Do not overload the prompt.
Use clear, simple object separation.
Use one bbox per major subject.
Use shorter text.
Keep preview images next to your JSON files.
Make a copy before heavily editing a template.
If something breaks, simplify the layout first.


============================================================
FINAL NOTE
============================================================

These templates are designed to help you quickly understand what Ideogram 4 can do with structured JSON prompting.

They are starting points, not locked final prompts.

The best way to use them is to pick a template close to what you want, change the subject, change the style, adjust the text, and generate a few tests.

Have fun.

Aitrepreneur